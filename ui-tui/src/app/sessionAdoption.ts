import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import type { Msg } from '../types.js'

import type { ServerPrompt, ServerPromptKey, ServerPromptState } from './createServerRequestHandler.js'
import { getOverlayState } from './overlayStore.js'
import { getServerRequest } from './serverRequestStore.js'
import { $sessionTransition } from './sessionTransitionStore.js'
import { getUiState } from './uiStore.js'

interface Adoption {
  start: number
  committed: boolean
  cancelled: Map<null | string | undefined, Set<string>>
}
interface Arrival {
  source: 'live' | 'progress' | 'snapshot'
  messages: Msg[]
  prompt: ServerPrompt
  publish: () => void
  published: boolean
  withdrawn: boolean
  sequence: number
}
interface ReplayResult {
  session_id: string
  open_requests?: unknown
}

const promptKeys = (arrival: Arrival) => Object.keys(arrival.prompt.overlay) as ServerPromptKey[]

const questionDefinition = (request: ServerRequest) =>
  JSON.stringify(
    (Array.isArray(request.params.questions) ? request.params.questions : []).map(question => ({
      qid: question?.qid,
      question: question?.question,
      choices: question?.choices,
      multiSelect: question?.multi_select === true
    }))
  )

/** One authority for create/activate/resume, including replies held by RPC wrappers. */
export class SessionAdoption {
  private current: Adoption | null = null
  private readonly pending = new Set<Adoption>()
  private readonly arrivals = new Map<ServerRequest, Arrival>()
  private sequence = 0
  private disposed = false

  begin(): Adoption {
    const adoption: Adoption = { start: this.sequence, committed: false, cancelled: new Map() }

    if (this.disposed) {
      return adoption
    }

    this.current = adoption
    this.pending.add(adoption)
    $sessionTransition.set(adoption)

    return adoption
  }

  owns(adoption: Adoption): boolean {
    return this.isCurrent(adoption) && $sessionTransition.get() === adoption
  }

  /** Committed title/finalize work retains its lease only until the next boundary. */
  isCurrent(adoption: Adoption): boolean {
    return !this.disposed && this.current === adoption
  }

  invalidate(): void {
    const previous = this.current
    this.current = null

    if ($sessionTransition.get() === previous) {
      $sessionTransition.set(null)
    }
  }

  finish(adoption: Adoption): void {
    this.pending.delete(adoption)

    if (this.owns(adoption)) {
      if (!adoption.committed) {
        this.current = null
      }

      $sessionTransition.set(null)
    }

    if (!this.pending.size) {
      this.arrivals.clear()
    }
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
    this.pending.clear()
    this.arrivals.clear()
  }

  openPrompt = (prompt: ServerPrompt, publish: () => void): void => {
    if (this.disposed) {
      return
    }

    const { request } = prompt
    const sid = request.params.session_id
    const foreign = Boolean(sid && sid !== getUiState().sid)

    const arrival: Arrival = {
      source: request.replayed ? 'snapshot' : 'live',
      messages: [],
      prompt,
      publish,
      published: false,
      withdrawn: false,
      sequence: ++this.sequence
    }

    if (this.pending.size) {
      this.arrivals.set(request, arrival)

      // Replay belongs to its decoded result, not to whichever transition is
      // current when the transport delivers it. Foreign live frames also wait.
      if (request.replayed || foreign) {
        return
      }
    } else if (foreign) {
      return
    }

    publish()
    arrival.published = true
  }

  cancel(sessionId: null | string | undefined, id: string): void {
    for (const adoption of this.pending) {
      const ids = adoption.cancelled.get(sessionId) ?? new Set<string>()
      ids.add(id)
      adoption.cancelled.set(sessionId, ids)
    }

    for (const [request, arrival] of this.arrivals) {
      if (request.id === id && request.params.session_id === sessionId) {
        // A later new live instance is independent of this withdrawal. Keep
        // this tombstone until settlement without reviving an older snapshot.
        arrival.withdrawn = true
      }
    }
  }

  /** The caller has checked the admitted action's exact prompt/session/request.
   * Record before notifying overlay subscribers: they may publish a successor. */
  progress = (prompt: ServerPrompt, messages: Msg[] = []): void => {
    if (!this.disposed && this.pending.size) {
      this.arrivals.set(prompt.request, {
        source: 'progress',
        messages,
        prompt,
        publish: () => {},
        published: true,
        withdrawn: false,
        sequence: ++this.sequence
      })
    }
  }

  private resolve(adoption: Adoption, result: ReplayResult): Arrival[] {
    const entries = Array.isArray(result.open_requests) ? result.open_requests : []

    const selected = [...this.arrivals.values()]
      .filter(arrival => {
        const { request } = arrival.prompt

        if (request.params.session_id !== result.session_id) {
          return false
        }

        if (arrival.source === 'snapshot') {
          // The channel passes the decoded params object directly to its real
          // request. Neither the latest wire ID nor a guessed SID alias owns it.
          return entries.some(
            entry => entry?.params === request.params && entry.id === request.id && entry.method === request.method
          )
        }

        return arrival.sequence > adoption.start
      })
      // Delivery time is not capture time. Replay is the baseline; post-begin
      // live observations and admitted progress override it in their own order.
      .sort((a, b) => Number(a.source !== 'snapshot') - Number(b.source !== 'snapshot') || a.sequence - b.sequence)

    const latestByKey = new Map<ServerPromptKey, Arrival>()
    const latestById = new Map<string, Arrival>()

    for (const arrival of selected) {
      const previous = latestById.get(arrival.prompt.request.id)

      // Progress can supersede a replay of its own question, not a visibly
      // different request definition merely reusing the same wire ID.
      if (
        arrival.source === 'progress' &&
        previous?.source === 'snapshot' &&
        (previous.prompt.request.method !== arrival.prompt.request.method ||
          questionDefinition(previous.prompt.request) !== questionDefinition(arrival.prompt.request))
      ) {
        continue
      }

      latestById.set(arrival.prompt.request.id, arrival)

      for (const key of promptKeys(arrival)) {
        const previousPrompt = latestByKey.get(key)

        if (
          arrival.source === 'progress' &&
          previousPrompt?.source === 'snapshot' &&
          previousPrompt.prompt.request.id !== arrival.prompt.request.id
        ) {
          continue
        }

        // Settlement retires its request, not an unrelated future question.
        // Live cancellation still masks an older per-kind snapshot beneath it.
        if (arrival.source !== 'progress' || arrival.prompt.overlay[key]) {
          latestByKey.set(key, arrival)
        }
      }
    }

    return selected.filter(
      arrival =>
        latestById.get(arrival.prompt.request.id) === arrival &&
        (arrival.source === 'progress' || !promptKeys(arrival).length || [...latestByKey.values()].includes(arrival))
    )
  }

  /** Publish selected actual instances, then pass one atomic snapshot to reset. */
  adopt(adoption: Adoption, result: ReplayResult): null | { prompts: ServerPromptState; messages: Msg[] } {
    if (!this.owns(adoption)) {
      return null
    }

    let winners = this.resolve(adoption, result)

    for (;;) {
      for (const arrival of winners) {
        if (
          arrival.source === 'snapshot' &&
          adoption.cancelled.get(result.session_id)?.has(arrival.prompt.request.id)
        ) {
          arrival.withdrawn = true
        }
      }

      const unpublished = winners.filter(arrival => !arrival.withdrawn && !arrival.published)

      if (!unpublished.length) {
        break
      }

      for (const arrival of unpublished) {
        arrival.published = true
        arrival.publish()

        if (!this.owns(adoption)) {
          return null
        }
      }

      // Publishing can synchronously deliver a newer live frame or cancellation.
      // Resolve again before reset, not from a frozen pre-publication winner set.
      winners = this.resolve(adoption, result)
    }

    const prompts: ServerPromptState = {}
    const overlay = getOverlayState()

    for (const { prompt, withdrawn } of winners) {
      const { request } = prompt

      if (withdrawn || getServerRequest(request.id) !== request) {
        continue
      }

      for (const key of Object.keys(prompt.overlay) as ServerPromptKey[]) {
        const value = overlay[key]

        if (value?.requestId === request.id) {
          Object.assign(prompts, { [key]: value })
        }
      }
    }

    adoption.committed = true

    return { prompts, messages: winners.flatMap(arrival => (arrival.withdrawn ? [] : arrival.messages)) }
  }
}
