import { writeFileSync } from 'node:fs'

import type { ScrollBoxHandle } from '@hermes/ink'
import { evictInkCaches } from '@hermes/ink'
import type { InflightTurn, SessionResumeResult, Usage } from '@hermes/shared/gateway-events'
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react'

import { STARTUP_WORKSPACE_CWD } from '../config/env.js'
import { buildSetupRequiredSections, setupRequiredTitle } from '../content/setup.js'
import { introMsg, toTranscriptMessages } from '../domain/messages.js'
import { ZERO } from '../domain/usage.js'
import { type GatewayClient } from '../gatewayClient.js'
import type {
  SessionActivateResponse,
  SessionCloseResponse,
  SessionCreateResponse,
  SessionTitleResponse,
  SetupStatusResponse
} from '../gatewayTypes.js'
import { t } from '../i18n/runtime.js'
import { asRpcResult } from '../lib/rpc.js'
import type { Msg, PanelSection, SessionInfo } from '../types.js'

import { applyConnectionRequest, clearConnectionOperation } from './connectionOperationStore.js'
import type { ServerPromptState } from './createServerRequestHandler.js'
import type { ComposerActions, GatewayRpc, StateSetter } from './interfaces.js'
import { patchOverlayState } from './overlayStore.js'
import { SessionAdoption } from './sessionAdoption.js'
import { scheduleResumeScrollToBottom } from './sessionResumeView.js'
import { turnController } from './turnController.js'
import { patchTurnState } from './turnStore.js'
import { getUiState, patchUiState } from './uiStore.js'
import { describeCredentialWarning } from './userMessages.js'

export { refreshSessionView, scheduleResumeScrollToBottom } from './sessionResumeView.js'

const usageFrom = (info: null | SessionInfo): Usage => (info?.usage ? { ...ZERO, ...info.usage } : ZERO)

const statusFromLiveSession = (status?: string, running = false) => {
  if (status === 'waiting') {
    return t('session.status.waitingForInput')
  }

  if (status === 'starting') {
    return t('session.status.startingAgent')
  }

  return running || status === 'working' ? 'running…' : 'ready'
}

export const writeActiveSessionFile = (sessionId: null | string, file = process.env.HERMES_TUI_ACTIVE_SESSION_FILE) => {
  if (!file || !sessionId) {
    return
  }

  try {
    writeFileSync(file, JSON.stringify({ session_id: sessionId }), { mode: 0o600 })
  } catch {
    // Best-effort shell epilogue hint only; never break live session changes.
  }
}

export const liveSessionInflightMessages = (inflight?: null | InflightTurn, conversationId?: null | string): Msg[] => {
  const user = String(inflight?.user ?? '')

  return user.trim()
    ? toTranscriptMessages(
        [
          {
            role: 'user',
            text: user,
            ...(inflight?.display_kind ? { display_kind: inflight.display_kind } : {}),
            ...(inflight?.display_metadata ? { display_metadata: inflight.display_metadata } : {})
          }
        ],
        conversationId
      )
    : []
}

export const hydrateLiveSessionInflight = (inflight?: null | InflightTurn) => {
  const assistant = String(inflight?.assistant ?? '')

  if (!assistant && !inflight?.streaming) {
    return
  }

  turnController.hydrateStreamingText(assistant)
}

export const signalFreshSessionBoundary = (
  previousSid: null | string,
  nextSid: null | string,
  onFreshSessionStarted?: (sessionId: string) => void
) => {
  if (!previousSid || !nextSid || previousSid === nextSid || !onFreshSessionStarted) {
    return false
  }

  onFreshSessionStarted(nextSid)

  return true
}

const trimTail = (items: Msg[]) => {
  const q = [...items]

  while (q.at(-1)?.role === 'assistant' || q.at(-1)?.role === 'tool') {
    q.pop()
  }

  if (q.at(-1)?.role === 'user') {
    q.pop()
  }

  return q
}

export interface UseSessionLifecycleOptions {
  colsRef: { current: number }
  composerActions: ComposerActions
  gw: GatewayClient
  onFreshSessionStarted?: (sessionId: string) => void
  panel: (title: string, sections: PanelSection[]) => void
  rpc: GatewayRpc
  scrollRef: RefObject<null | ScrollBoxHandle>
  setHistoryItems: StateSetter<Msg[]>
  setLastUserMsg: StateSetter<string>
  setSessionStartedAt: StateSetter<number>
  setStickyPrompt: StateSetter<string>
  setVoiceProcessing: StateSetter<boolean>
  setVoiceRecording: StateSetter<boolean>
  sys: (text: string) => void
}

export function useSessionLifecycle(opts: UseSessionLifecycleOptions) {
  const {
    colsRef,
    composerActions,
    gw,
    onFreshSessionStarted,
    panel,
    rpc,
    scrollRef,
    setHistoryItems,
    setLastUserMsg,
    setSessionStartedAt,
    setStickyPrompt,
    setVoiceProcessing,
    setVoiceRecording,
    sys
  } = opts

  // Plugin on_session_finalize text comes back on the close result and is shown as system lines (never a
  // model turn). `deferMessages`: the caller resets the transcript next and shows them itself afterwards.
  const closeSession = useCallback(
    async (targetSid?: null | string, deferMessages = false, isCurrent?: () => boolean) => {
      const closed = targetSid
        ? await rpc<SessionCloseResponse>('session.close', { session_id: targetSid }, isCurrent)
        : null

      if (!deferMessages && (!isCurrent || isCurrent())) {
        closed?.messages?.forEach(message => sys(message))
      }

      return closed
    },
    [rpc, sys]
  )

  const cancelResumeScrollRef = useRef<null | (() => void)>(null)
  const adoption = useMemo(() => new SessionAdoption(), [])

  const resetSessionState = useCallback(
    (sessionPrompts: ServerPromptState = {}) => {
      cancelResumeScrollRef.current?.()
      cancelResumeScrollRef.current = null
      turnController.fullReset(sessionPrompts)
      setVoiceRecording(false)
      setVoiceProcessing(false)
      patchUiState({ bgTasks: new Set(), info: null, sid: null, storedSid: null, usage: ZERO })
      setHistoryItems([])
      setLastUserMsg('')
      setStickyPrompt('')
      // Half-prune: new session has new keys, but keep a warm pool in case
      // the user resumes back to the prior session.
      evictInkCaches('half')
    },
    [setHistoryItems, setLastUserMsg, setStickyPrompt, setVoiceProcessing, setVoiceRecording]
  )

  const resetSession = useCallback(() => {
    adoption.invalidate()
    resetSessionState()
    composerActions.setComposerTokens([])
  }, [adoption, composerActions, resetSessionState])

  useEffect(
    () => () => {
      cancelResumeScrollRef.current?.()
      cancelResumeScrollRef.current = null
      adoption.dispose()
    },
    [adoption]
  )

  const resetVisibleHistory = useCallback(
    (info: null | SessionInfo = null) => {
      turnController.idle()
      turnController.clearReasoning()
      turnController.turnTools = []
      turnController.persistedToolLabels.clear()

      setHistoryItems(info ? [introMsg(info)] : [])
      setStickyPrompt('')
      setLastUserMsg('')
      composerActions.setComposerTokens([])
      patchTurnState({ activity: [] })
      patchUiState({ info, usage: usageFrom(info) })
    },
    [composerActions, setHistoryItems, setLastUserMsg, setStickyPrompt]
  )

  const startNewSession = useCallback(
    async (msg?: string, title?: string, keepCurrent = false) => {
      const transition = adoption.begin()
      const isCurrent = () => adoption.isCurrent(transition)

      try {
        if (!adoption.owns(transition)) {
          return null
        }

        const setup = await rpc<SetupStatusResponse>('setup.status', {}, isCurrent)

        if (!adoption.owns(transition)) {
          return null
        }

        if (setup?.provider_configured === false) {
          panel(setupRequiredTitle(), buildSetupRequiredSections())
          patchUiState({ status: t('session.status.setupRequired') })

          return null
        }

        // No documented legacy fallback: unsupported, failed and malformed
        // setup all fail closed before closing or creating any session.
        if (typeof setup?.provider_configured !== 'boolean') {
          if (setup) {
            sys(`error: ${t('session.common.invalidResponse', 'setup.status')}`)
          }

          return null
        }

        const previousSid = getUiState().sid
        const closed = keepCurrent ? null : await closeSession(previousSid, true, isCurrent)

        if (!adoption.owns(transition)) {
          return null
        }

        const r = await rpc<SessionCreateResponse>(
          'session.create',
          {
            cols: colsRef.current,
            ...(STARTUP_WORKSPACE_CWD ? { cwd: STARTUP_WORKSPACE_CWD } : {})
          },
          isCurrent
        )

        if (!adoption.owns(transition)) {
          return null
        }

        if (!r || typeof r.session_id !== 'string' || !r.session_id) {
          patchUiState({ status: 'ready' })

          return null
        }

        // The durable id lives on the create result; the lazy-create `info` does
        // not carry it, and session.resume / the exit epilogue need the stored id.
        const storedSid = r.stored_session_id || r.session_id
        const info = r.info ? { ...r.info, stored_session_id: storedSid } : null
        const requestedTitle = title?.trim() ?? ''

        const adopted = adoption.adopt(transition, r)

        if (!adopted) {
          return null
        }

        resetSessionState(adopted.prompts)
        composerActions.setComposerTokens([])
        setSessionStartedAt(Date.now())

        writeActiveSessionFile(storedSid)
        patchUiState({
          info,
          sid: r.session_id,
          status: info?.version ? 'ready' : t('session.status.startingAgent'),
          storedSid,
          usage: usageFrom(info)
        })

        if (info) {
          setHistoryItems([introMsg(info), ...adopted.messages])
        } else if (adopted.messages.length) {
          setHistoryItems(adopted.messages)
        }

        if (info?.credential_warning) {
          sys(`warning: ${describeCredentialWarning(info.credential_warning)}`)
        }

        if (info?.config_warning) {
          sys(`warning: ${info.config_warning}`)
        }

        if (msg) {
          sys(msg)
        }

        // After the reset above, so the closed session's plugin messages stay visible.
        closed?.messages?.forEach(message => sys(message))

        if (requestedTitle) {
          rpc<SessionTitleResponse>(
            'session.title',
            {
              session_id: r.session_id,
              title: requestedTitle
            },
            isCurrent
          )
            .then(result => {
              if (!result || !isCurrent() || getUiState().sid !== r.session_id) {
                return
              }

              const nextTitle = (result.title ?? requestedTitle).trim()
              const suffix = result.pending ? t('session.lifecycle.titleQueuedSuffix') : ''
              patchUiState({ sessionTitle: nextTitle })
              sys(`${t('session.lifecycle.sessionTitleSet', nextTitle)}${suffix}`)
            })
            .catch((err: unknown) => {
              if (!isCurrent() || getUiState().sid !== r.session_id) {
                return
              }

              const message = err instanceof Error ? err.message : String(err)
              sys(`warning: ${t('session.lifecycle.failedToSetTitle', message)}`)
            })
        }

        signalFreshSessionBoundary(previousSid, r.session_id, onFreshSessionStarted)

        return r.session_id
      } catch (error) {
        if (adoption.owns(transition)) {
          sys(`error: ${error instanceof Error ? error.message : String(error)}`)
        }

        return null
      } finally {
        adoption.finish(transition)
      }
    },
    [
      adoption,
      closeSession,
      colsRef,
      composerActions,
      onFreshSessionStarted,
      panel,
      resetSessionState,
      rpc,
      setHistoryItems,
      setSessionStartedAt,
      sys
    ]
  )

  const newSession = useCallback(
    (msg?: string, title?: string) => startNewSession(msg, title, false),
    [startNewSession]
  )

  const newLiveSession = useCallback(
    (msg = t('session.lifecycle.newLiveSessionStarted'), title?: string) => {
      patchOverlayState({ sessions: false })

      return startNewSession(msg, title, true)
    },
    [startNewSession]
  )

  const activateLiveSession = useCallback(
    (id: string) => {
      const transition = adoption.begin()

      if (!adoption.owns(transition)) {
        adoption.finish(transition)

        return
      }

      patchOverlayState({ sessions: false })
      patchUiState({ status: t('session.status.switchingSession') })
      // The card belongs to the session being left; the activated one answers with its own.
      clearConnectionOperation()

      return gw
        .request<SessionActivateResponse>('session.activate', { session_id: id })
        .then(raw => {
          if (!adoption.owns(transition)) {
            return
          }

          const r = asRpcResult<SessionActivateResponse>(raw)

          if (!r || typeof r.session_id !== 'string' || !r.session_id) {
            sys(`error: ${t('session.common.invalidResponse', 'session.activate')}`)

            return patchUiState({ status: 'ready' })
          }

          const info = r.info ?? null
          // Agent-less (lazy) activations answer with `_fallback_session_info`, which
          // has no stored_session_id; the durable id is the response's session_key.
          const storedSid = r.session_key || r.session_id
          const running = Boolean(r.running || r.status === 'working' || r.status === 'waiting')

          const transcript = [
            ...toTranscriptMessages(r.messages, storedSid),
            ...liveSessionInflightMessages(r.inflight, storedSid)
          ]

          const adopted = adoption.adopt(transition, r)

          if (!adopted) {
            return
          }

          resetSessionState(adopted.prompts)
          setSessionStartedAt(r.started_at ? r.started_at * 1000 : Date.now())
          setHistoryItems([...(info ? [introMsg(info)] : []), ...transcript, ...adopted.messages])
          writeActiveSessionFile(storedSid)
          patchUiState({
            busy: running,
            info,
            sid: r.session_id,
            status: statusFromLiveSession(r.status, running),
            storedSid,
            usage: usageFrom(info)
          })
          hydrateLiveSessionInflight(r.inflight)

          if (r.pending_connection) {
            applyConnectionRequest(r.pending_connection)
          }

          cancelResumeScrollRef.current?.()
          cancelResumeScrollRef.current = scheduleResumeScrollToBottom(scrollRef)
        })
        .catch((e: Error) => {
          if (!adoption.owns(transition)) {
            return
          }

          sys(`error: ${e.message}`)
          patchUiState({ status: 'ready' })
        })
        .finally(() => adoption.finish(transition))
    },
    [adoption, gw, resetSessionState, scrollRef, setHistoryItems, setSessionStartedAt, sys]
  )

  const resumeById = useCallback(
    async (id: string) => {
      const previousStatus = getUiState().status
      const transition = adoption.begin()
      const isCurrent = () => adoption.isCurrent(transition)

      if (!adoption.owns(transition)) {
        adoption.finish(transition)

        return
      }

      patchOverlayState({ sessions: false })
      patchUiState({ status: t('session.status.resuming') })

      return rpc<SetupStatusResponse>('setup.status', {}, isCurrent)
        .then(setup => {
          if (!adoption.owns(transition)) {
            return
          }

          if (setup?.provider_configured === false) {
            panel(setupRequiredTitle(), buildSetupRequiredSections())
            patchUiState({ status: t('session.status.setupRequired') })

            return
          }

          if (typeof setup?.provider_configured !== 'boolean') {
            if (setup) {
              sys(`error: ${t('session.common.invalidResponse', 'setup.status')}`)
            }

            patchUiState({ status: previousStatus })

            return
          }

          const previousSid = getUiState().sid

          return gw
            .request<SessionResumeResult>('session.resume', { cols: colsRef.current, session_id: id })
            .then(raw => {
              if (!adoption.owns(transition)) {
                return
              }

              const r = asRpcResult<SessionResumeResult>(raw)

              if (!r || typeof r.session_id !== 'string' || !r.session_id) {
                sys(`error: ${t('session.common.invalidResponse', 'session.resume')}`)

                return patchUiState({ status: 'ready' })
              }

              const storedSid = r.info?.stored_session_id || r.stored_session_id || r.resumed || id
              const info = r.info ? { ...r.info, stored_session_id: storedSid } : null

              const running = Boolean(r.running || r.status === 'working' || r.status === 'waiting')

              const resumed = [
                ...toTranscriptMessages(r.messages, storedSid),
                ...liveSessionInflightMessages(r.inflight, storedSid)
              ]

              const adopted = adoption.adopt(transition, r)

              if (!adopted) {
                return
              }

              resetSessionState(adopted.prompts)
              setSessionStartedAt(r.started_at ? r.started_at * 1000 : Date.now())
              setHistoryItems([...(info ? [introMsg(info)] : []), ...resumed, ...adopted.messages])
              writeActiveSessionFile(storedSid)
              patchUiState({
                busy: running,
                info,
                sid: r.session_id,
                status: statusFromLiveSession(r.status ?? undefined, running),
                storedSid,
                usage: usageFrom(info)
              })
              hydrateLiveSessionInflight(r.inflight)

              if (r.pending_connection) {
                applyConnectionRequest(r.pending_connection)
              } else {
                clearConnectionOperation()
              }

              cancelResumeScrollRef.current?.()
              cancelResumeScrollRef.current = scheduleResumeScrollToBottom(scrollRef)

              if (previousSid && previousSid !== r.session_id) {
                void closeSession(previousSid, false, isCurrent)
              }
            })
            .catch((e: Error) => {
              if (!adoption.owns(transition)) {
                return
              }

              sys(`error: ${e.message}`)
              patchUiState({ status: 'ready' })
            })
        })
        .catch((error: unknown) => {
          if (adoption.owns(transition)) {
            sys(`error: ${error instanceof Error ? error.message : String(error)}`)
            patchUiState({ status: previousStatus })
          }
        })
        .finally(() => adoption.finish(transition))
    },
    [
      adoption,
      closeSession,
      colsRef,
      gw,
      panel,
      resetSessionState,
      rpc,
      scrollRef,
      setHistoryItems,
      setSessionStartedAt,
      sys
    ]
  )

  const guardBusySessionSwitch = useCallback(
    (what = t('session.lifecycle.switchSessions')) => {
      if (!getUiState().busy) {
        return false
      }

      sys(t('session.lifecycle.interruptBeforeSwitch', what))

      return true
    },
    [sys]
  )

  return useMemo(
    () => ({
      adoption,
      activateLiveSession,
      closeSession,
      guardBusySessionSwitch,
      newLiveSession,
      newSession,
      resetSession,
      resetVisibleHistory,
      resumeById,
      trimLastExchange: trimTail
    }),
    [
      adoption,
      activateLiveSession,
      closeSession,
      guardBusySessionSwitch,
      newLiveSession,
      newSession,
      resetSession,
      resetVisibleHistory,
      resumeById,
      trimTail
    ]
  )
}
