import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef } from 'react'

import type { ClarifyLockResponse } from '../gatewayTypes.js'
import { t } from '../i18n/runtime.js'
import {
  buildToolTrailLine,
  clarifyAnswerText,
  formatAbandonedClarify,
  sameToolTrailGroup,
  toolTrailLabel
} from '../lib/text.js'
import type { Msg } from '../types.js'

import type { ServerPrompt } from './createServerRequestHandler.js'
import type { GatewayRpc, OverlayState } from './interfaces.js'
import { getActivePromptKey, getOverlayState, patchOverlayState } from './overlayStore.js'
import { capturePromptOwner, clearOwnedPrompt, ownsPrompt, type PromptOwner } from './promptOwnership.js'
import { forgetServerRequest, respondToServerRequest } from './serverRequestStore.js'
import { turnController } from './turnController.js'
import { patchTurnState } from './turnStore.js'
import { $uiSessionId, patchUiState } from './uiStore.js'

const REQUEST_PROMPTS = ['approval', 'clarify', 'sudo', 'secret', 'vaultUnlock', 'vaultSaveLogin', 'vaultCode'] as const

export function useDecisionActions(
  overlay: OverlayState,
  rpc: GatewayRpc,
  appendMessage: (msg: Msg) => void,
  sys: (text: string) => void,
  onProgress?: (prompt: ServerPrompt, messages?: Msg[]) => void
) {
  const sid = useStore($uiSessionId)

  const owners = useMemo(
    () =>
      Object.fromEntries(REQUEST_PROMPTS.map(key => [key, capturePromptOwner(key, overlay[key], sid)])) as Record<
        (typeof REQUEST_PROMPTS)[number],
        PromptOwner | null
      >,
    [overlay, sid]
  )

  const locking = useRef(new WeakSet<object>())
  const active = useRef(true)
  useEffect(() => {
    active.current = true

    return () => {
      active.current = false
    }
  }, [])

  const respondWith = (owner: PromptOwner | null, result: Record<string, unknown>, done?: () => void) => {
    if (!ownsPrompt(owner) || !owner.request) {
      return
    }

    try {
      if (!respondToServerRequest(owner.request.id, result, owner.request)) {
        return
      }

      if (clearOwnedPrompt(owner)) {
        done?.()

        if (!getActivePromptKey(getOverlayState())) {
          patchUiState({ status: 'running…' })
        }
      }
    } catch {
      // A transport failure is not a dismissal. Keep the request/card for retry.
      if (ownsPrompt(owner)) {
        sys('error: could not answer request; please retry')
      }
    }
  }

  const cancelClarify = () => {
    const owner = owners.clarify
    const clarify = overlay.clarify

    if (!clarify || !ownsPrompt(owner)) {
      return
    }

    respondWith(owner, {}, () => {
      const label = toolTrailLabel('clarify')
      turnController.turnTools = turnController.turnTools.filter(line => !sameToolTrailGroup(label, line))
      patchTurnState({ turnTrail: turnController.turnTools })
      appendMessage({
        role: 'system',
        text: formatAbandonedClarify(clarify.questions, clarify.answers ?? {}, 'cancelled')
      })
    })
  }

  const answerClarifyQuestion = (qid: string, answer: string) => {
    const owner = owners.clarify
    const clarify = overlay.clarify

    if (
      !clarify ||
      !ownsPrompt(owner) ||
      !owner.request ||
      locking.current.has(clarify) ||
      !clarify.questions.some(q => q.qid === qid)
    ) {
      return
    }

    locking.current.add(clarify)
    const request = owner.request
    const isCurrent = () => active.current && ownsPrompt(owner, true)
    rpc<ClarifyLockResponse>(
      'clarify.lock',
      {
        answer: answer.trim() ? answer : null,
        question_id: qid,
        request_id: clarify.requestId
      },
      isCurrent
    )
      .then(r => {
        if (!r || !active.current || !ownsPrompt(owner, true)) {
          return
        }

        const answers = { ...(clarify.answers ?? {}), [qid]: answer }

        if (r.status === 'expired') {
          forgetServerRequest(clarify.requestId, request)
          onProgress?.({ request, overlay: { clarify: null } })
          clearOwnedPrompt(owner)

          return
        }

        if ((r.remaining ?? []).length > 0) {
          const next = { ...clarify, answers }
          onProgress?.({ request, overlay: { clarify: next } })
          patchOverlayState({ clarify: next })

          return
        }

        forgetServerRequest(clarify.requestId, request)
        const count = clarify.questions.length

        const trail: Msg = {
          kind: 'trail',
          role: 'system',
          text: '',
          tools: [
            buildToolTrailLine(
              'clarify',
              t(count === 1 ? 'session.main.clarifyQuestionsOne' : 'session.main.clarifyQuestionsOther', String(count))
            )
          ]
        }

        const answerMessage: Msg = {
          role: 'user',
          text: clarify.questions
            .map(
              q =>
                `${q.question} → ${answers[q.qid]?.trim() ? clarifyAnswerText(answers[q.qid]!, q.multiSelect) : t('session.main.skipped')}`
            )
            .join('\n')
        }

        const messages = [trail, answerMessage]
        onProgress?.({ request, overlay: { clarify: null } }, messages)

        if (!clearOwnedPrompt(owner)) {
          return
        }

        const label = toolTrailLabel('clarify')
        turnController.turnTools = turnController.turnTools.filter(line => !sameToolTrailGroup(label, line))
        patchTurnState({ turnTrail: turnController.turnTools })
        turnController.persistedToolLabels.add(label)
        messages.forEach(appendMessage)

        if (!getActivePromptKey(getOverlayState())) {
          patchUiState({ status: 'running…' })
        }
      })
      .catch(() => {
        if (isCurrent()) {
          sys('error: could not answer question; please retry')
        }
      })
      .finally(() => locking.current.delete(clarify))
  }

  return {
    answerApproval: (choice: string) =>
      respondWith(owners.approval, { choice }, () =>
        patchTurnState({
          outcome: choice === 'deny' ? t('session.approval.denied') : t('session.approval.approved', choice)
        })
      ),
    answerClarifyQuestion,
    cancelClarify,
    answerSudo: (value: string) => respondWith(owners.sudo, { value }),
    answerSecret: (value: string) => respondWith(owners.secret, { value }),
    answerVaultUnlock: (value: string) => respondWith(owners.vaultUnlock, { value }),
    answerVaultSaveLogin: (identifier: string, password: string) =>
      respondWith(owners.vaultSaveLogin, {
        value: identifier && password ? JSON.stringify({ identifier, password }) : ''
      }),
    answerVaultCode: (code: string) => respondWith(owners.vaultCode, { value: code.trim() })
  }
}
