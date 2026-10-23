import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import { t } from '../i18n/runtime.js'
import type { ClarifyQuestion } from '../types.js'

import type { OverlayState } from './interfaces.js'
import { patchOverlayState } from './overlayStore.js'
import { rememberServerRequest } from './serverRequestStore.js'

export type ServerPromptKey =
  'approval' | 'clarify' | 'sudo' | 'secret' | 'vaultUnlock' | 'vaultSaveLogin' | 'vaultCode'
export type ServerPromptState = Partial<Pick<OverlayState, ServerPromptKey>>
export interface ServerPrompt {
  request: ServerRequest
  overlay: ServerPromptState
}

export interface ServerRequestHandlerContext {
  ringPromptBell: () => void
  setStatus: (status: string) => void
  openPrompt?: (prompt: ServerPrompt, publish: () => void) => void
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const strList = (v: unknown): null | string[] =>
  Array.isArray(v) && v.length > 0 ? v.filter((c): c is string => typeof c === 'string') : null

/** Prepare the real request's card before publishing it; adoption may own its publication. */
export function createServerRequestHandler(ctx: ServerRequestHandlerContext): (request: ServerRequest) => boolean {
  const { ringPromptBell, setStatus } = ctx

  const open = (request: ServerRequest, status: string, overlay: ServerPromptState) => {
    const publish = () => {
      if (!Object.keys(overlay).length) {
        request.respond({})

        return
      }

      rememberServerRequest(request)
      patchOverlayState(overlay)
      setStatus(status)

      if (!request.replayed) {
        ringPromptBell()
      }
    }

    if (ctx.openPrompt) {
      ctx.openPrompt({ overlay, request }, publish)
    } else {
      publish()
    }
  }

  return request => {
    const p = request.params

    switch (request.method) {
      case 'clarify': {
        const questions: ClarifyQuestion[] = (Array.isArray(p.questions) ? (p.questions as unknown[]) : [])
          .map(raw => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}))
          .filter(q => str(q.qid) && str(q.question).trim())
          .map(q => ({
            choices: strList(q.choices),
            multiSelect: q.multi_select === true,
            qid: str(q.qid),
            question: str(q.question).trim()
          }))

        if (!questions.length) {
          open(request, '', {})

          return true
        }

        const answers =
          p.answers && typeof p.answers === 'object'
            ? Object.fromEntries(
                Object.entries(p.answers as Record<string, unknown>)
                  .map(([qid, answer]): [string, unknown] => [qid, answer === null ? '' : answer])
                  .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
              )
            : {}

        open(request, t('session.status.waitingForInput'), { clarify: { answers, questions, requestId: request.id } })

        return true
      }

      case 'approval':
        open(request, t('session.status.approvalNeeded'), {
          approval: {
            allowPermanent: p.allow_permanent !== false,
            choices: strList(p.choices) ?? undefined,
            command: str(p.command),
            description: str(p.description) || t('session.request.dangerousCommand'),
            requestId: request.id,
            smartDenied: p.smart_denied === true
          }
        })

        return true

      case 'sudo':
        open(request, t('session.status.sudoPasswordNeeded'), { sudo: { requestId: request.id } })

        return true

      case 'secret':
        open(request, t('session.status.secretInputNeeded'), {
          secret: { envVar: str(p.env_var), prompt: str(p.prompt), requestId: request.id }
        })

        return true

      case 'vault.unlock_prompt':
        open(request, t('session.status.unlockVault', str(p.display_name)), {
          vaultUnlock: { backend: str(p.backend), displayName: str(p.display_name), requestId: request.id }
        })

        return true
      case 'vault.save_login': {
        const site = str(p.site) || str(p.origin)
        open(request, t('session.status.saveLogin', site), {
          vaultSaveLogin: { origin: str(p.origin), requestId: request.id, site }
        })

        return true
      }

      case 'vault.code': {
        const site = str(p.site)
        open(request, t('session.status.verificationCode', site), {
          vaultCode: { hint: str(p.hint), requestId: request.id, site }
        })

        return true
      }

      default:
        // Desktop-only bridges must still fail fast, including during adoption.
        return false
    }
  }
}
