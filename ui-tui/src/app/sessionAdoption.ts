import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import type { ServerPrompt, ServerPromptKey, ServerPromptState } from './createServerRequestHandler.js'
import { getOverlayState } from './overlayStore.js'
import { getServerRequest } from './serverRequestStore.js'
import { $sessionTransition } from './sessionTransitionStore.js'
import { getUiState } from './uiStore.js'

interface Adoption {
  start: number
  cancelled: Map<null | string | undefined, Set<string>>
}
interface Arrival {
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

/** One authority for create/activate/resume, including replies held by RPC wrappers. */
export class SessionAdoption {
  private current: Adoption | null = null
  private readonly pending = new Set<Adoption>()
  private readonly arrivals = new Map<ServerRequest, Arrival>()
  private sequence = 0
  private disposed = false

  begin(): Adoption {
    const adoption: Adoption = { start: this.sequence, cancelled: new Map() }

    if (this.disposed) {
      return adoption
    }

    this.current = adoption
    this.pending.add(adoption)
    $sessionTransition.set(adoption)

    return adoption
  }

  owns(adoption: Adoption): boolean {
    return !this.disposed && this.current === adoption && $sessionTransition.get() === adoption
  }

  invalidate(): void {
    if ($sessionTransition.get() === this.current) {
      $sessionTransition.set(null)
    }

    this.current = null
  }

  finish(adoption: Adoption): void {
    this.pending.delete(adoption)

    if (this.owns(adoption)) {
      this.invalidate()
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
    const arrival = { prompt, publish, published: false, withdrawn: false, sequence: ++this.sequence }

    if (this.pending.size) {
      this.arrivals.set(request, arrival)

      // Replay is not authoritative until its owning result is adopted. In
      // particular a superseded same-SID reply must not replace a newer card.
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
        // Keep a tombstone until the reply settles: withdrawing a newer
        // arrival must not reveal an earlier snapshot of the same card.
        arrival.withdrawn = true
      }
    }
  }

  /** Publish selected actual instances, then pass one atomic overlay snapshot to reset. */
  adopt(adoption: Adoption, result: ReplayResult): null | ServerPromptState {
    const entries = Array.isArray(result.open_requests) ? result.open_requests : []

    const selected = [...this.arrivals.values()].filter(arrival => {
      const { request } = arrival.prompt

      if (request.params.session_id !== result.session_id) {
        return false
      }

      if (request.replayed) {
        // The real channel hands the decoded entry's params object directly
        // to its request. Associate by that object, never latest wire ID or a
        // guessed durable/runtime SID alias. No channel API/order change.
        return entries.some(
          entry => entry?.params === request.params && entry.id === request.id && entry.method === request.method
        )
      }

      return arrival.sequence > adoption.start
    })

    const prompts: ServerPromptState = {}

    if (!this.owns(adoption)) {
      return null
    }

    const latestByKey = new Map<ServerPromptKey, Arrival>()
    const latestById = new Map<string, Arrival>()

    for (const arrival of selected) {
      latestById.set(arrival.prompt.request.id, arrival)

      for (const key of Object.keys(arrival.prompt.overlay) as ServerPromptKey[]) {
        latestByKey.set(key, arrival)
      }
    }

    const winners = selected.filter(
      arrival =>
        latestById.get(arrival.prompt.request.id) === arrival &&
        (!Object.keys(arrival.prompt.overlay).length || [...latestByKey.values()].includes(arrival))
    )

    for (const arrival of winners) {
      const request = arrival.prompt.request

      if (request.replayed && adoption.cancelled.get(result.session_id)?.has(request.id)) {
        arrival.withdrawn = true
      }

      if (!arrival.withdrawn && !arrival.published) {
        arrival.publish()
        arrival.published = true
      }
    }

    if (!this.owns(adoption)) {
      return null
    }

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

    return prompts
  }
}
