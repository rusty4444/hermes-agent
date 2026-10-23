import { PassThrough } from 'node:stream'

import { AlternateScreen, Box, renderSync, Text } from '@hermes/ink'
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Resolve the real Ink source so the test can read its screen buffer and hit
// test it. No renderer, input parser, focus manager or component is stubbed.
vi.mock('@hermes/ink', async () => import('../../packages/hermes-ink/src/entry-exports.js'))

import instances from '../../packages/hermes-ink/src/ink/instances.js'
import { renderToScreen } from '../../packages/hermes-ink/src/ink/render-to-screen.js'
import { cellAtIndex, type Screen } from '../../packages/hermes-ink/src/ink/screen.js'
import { createGatewayEventHandler } from '../app/createGatewayEventHandler.js'
import { $expandedJobNotices } from '../app/internalJobNoticeStore.js'
import { patchOverlayState, resetOverlayState } from '../app/overlayStore.js'
import { turnController } from '../app/turnController.js'
import { resetTurnState } from '../app/turnStore.js'
import { getUiState, patchUiState, resetUiState } from '../app/uiStore.js'
import { liveSessionInflightMessages } from '../app/useSessionLifecycle.js'
import { MessageLine } from '../components/messageLine.js'
import { TextInput } from '../components/textInput.js'
import { toTranscriptMessages } from '../domain/messages.js'
import { appendTranscriptMessage, capTranscriptHistory } from '../lib/messages.js'
import { DEFAULT_THEME } from '../theme.js'
import type { Msg } from '../types.js'

const body =
  '[ASYNC DELEGATION BATCH COMPLETE — deleg_fixture]\nREADY report\nfull verbatim evidence\n/transcripts/worker.jsonl\n'

const basePayload = {
  text: body,
  display_kind: 'async_delegation_complete',
  display_metadata: {
    has_issues: true,
    notice_id: 'delegation:deleg_fixture:complete',
    display_text: 'Subagent Tasks Finished with Issues: Review (2 tasks)'
  }
}

beforeEach(() => {
  $expandedJobNotices.set(new Set())
  resetUiState()
  resetTurnState()
  resetOverlayState()
  turnController.fullReset()
  patchUiState({ sid: 'owner' })
})
afterEach(() => {
  turnController.fullReset()
  resetOverlayState()
})

const liveContext = (history: { items: Msg[] }) => ({
  composer: { dequeue: () => undefined, queueEditRef: { current: null }, sendQueued: vi.fn(), setInput: vi.fn() },
  gateway: { gw: { request: vi.fn(async () => null) }, rpc: vi.fn(async () => null) },
  session: {
    STARTUP_RESUME_ID: '',
    colsRef: { current: 80 },
    newSession: vi.fn(),
    resetSession: vi.fn(),
    resumeById: vi.fn(),
    setCatalog: vi.fn()
  },
  submission: { submitRef: { current: vi.fn() } },
  system: { bellOnComplete: false, sys: vi.fn() },
  transcript: {
    appendMessage: (msg: Msg) => {
      history.items = appendTranscriptMessage(history.items, msg)
    },
    panel: vi.fn(),
    setHistoryItems: vi.fn()
  },
  voice: { setProcessing: vi.fn(), setRecording: vi.fn(), setVoiceEnabled: vi.fn() }
})

it.each(['async_delegation_complete', 'process_complete'])(
  'normalizes %s live start, replay, resume and in-flight to the same non-user card',
  kind => {
    const payload = { ...basePayload, display_kind: kind }
    const history = { items: [] as Msg[] }
    const onEvent = createGatewayEventHandler(liveContext(history) as any)
    onEvent({ session_id: 'owner', type: 'message.start', payload })
    onEvent({ session_id: 'owner', type: 'message.start', payload })
    expect(history.items).toHaveLength(1)
    expect(getUiState().busy).toBe(true)
    expect(history.items[0]).toMatchObject({ role: 'system', kind: 'event', jobNotice: { body } })
    const resumed = toTranscriptMessages([{ role: 'user', ...payload }])
    const inflight = liveSessionInflightMessages({ user: body, ...payload } as any)
    expect(history.items[0]?.jobNotice).toEqual(resumed[0]?.jobNotice)
    expect(inflight[0]?.jobNotice).toEqual(resumed[0]?.jobNotice)
    expect(capTranscriptHistory([...resumed, ...inflight])).toHaveLength(1)
    const [quoted] = toTranscriptMessages([{ role: 'user', text: body }])
    expect(quoted).toEqual({ role: 'user', text: body })
    const decorated = toTranscriptMessages([{ role: 'user', ...payload, text: body + '[recall context] memory' }])[0]!
    expect(decorated.jobNotice?.id).toBe(resumed[0]?.jobNotice?.id)
    expect(decorated.jobNotice?.body).toBe(body + '[recall context] memory')
  }
)

it.each(['async_delegation_complete', 'process_complete'])(
  '%s renders compact, expands by click and keyboard, and keeps state across remount/resume',
  async kind => {
    const payload = { ...basePayload, display_kind: kind }
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: false })

    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
      ref: () => {},
      unref: () => {}
    })

    const onSubmit = vi.fn()
    const onChange = vi.fn()
    const message = toTranscriptMessages([{ role: 'user', ...payload }])[0]!

    const tree = (msg: Msg) => (
      <AlternateScreen>
        <Box flexDirection="column" height={24}>
          <MessageLine cols={100} msg={msg} t={DEFAULT_THEME} />
          <TextInput onChange={onChange} onSubmit={onSubmit} value="unsent draft" />
        </Box>
      </AlternateScreen>
    )

    const view = renderSync(tree(message), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
      patchConsole: false
    })

    const ink = instances.get(stdout as unknown as NodeJS.WriteStream)!
    // AlternateScreen binds process.stdout in production; this harness renders
    // to an isolated stream, so activate its real alternate-screen machinery.
    ink.setAltScreenActive(true)

    const screenText = () => {
      const screen = (ink as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen

      return Array.from({ length: screen.height }, (_, y) =>
        Array.from({ length: screen.width }, (_, x) => cellAtIndex(screen, y * screen.width + x).char)
          .join('')
          .trimEnd()
      ).join('\n')
    }

    try {
      await vi.waitFor(() => expect(screenText()).toContain('Expand details'))
      expect(screenText()).toContain('Internal job')
      expect(screenText()).toContain('Finished with Issues')
      expect(screenText()).not.toContain('READY report')
      expect(screenText()).not.toContain('ASYNC DELEGATION')
      // Raw SGR input must hit-test the toggle's second row, not a React prop.
      stdin.write('\x1b[<0;4;2M\x1b[<0;4;2m')
      await vi.waitFor(() => expect(screenText()).toContain('Collapse details'))
      expect(screenText()).toContain(body.trimEnd())
      view.rerender(<Box />)
      view.rerender(tree(toTranscriptMessages([{ role: 'user', ...payload }])[0]!))
      await vi.waitFor(() => expect(screenText()).toContain('Collapse details'))
      // Tab focus, then Enter/Space must toggle without submitting/editing a draft.
      stdin.write('\t')
      await vi.waitFor(() => expect(ink.focusManager.activeElement).toBeTruthy())
      stdin.write('\r')
      await vi.waitFor(() => expect(screenText()).toContain('Expand details'))
      expect(screenText()).not.toContain('READY report')
      stdin.write(' ')
      await vi.waitFor(() => expect(screenText()).toContain('Collapse details'))
      expect(onSubmit).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      stdin.write('\x1b')
      await vi.waitFor(() => expect(ink.focusManager.activeElement).toBeNull())
      expect(screenText()).not.toContain('Esc: composer')
      stdin.write('\t')
      await vi.waitFor(() => expect(screenText()).toContain('Esc: composer'))
      // A blocking approval/clarify/sudo overlay takes precedence, never this control.
      patchOverlayState({ sudo: { requestId: 'sudo', prompt: 'Password' } as any })
      const prior = $expandedJobNotices.get()
      stdin.write('\r')
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
      expect($expandedJobNotices.get()).toBe(prior)
    } finally {
      view.unmount()
      view.cleanup()
    }
  }
)

it.each(['async_delegation_complete', 'process_complete'])(
  '%s keeps huge reports compact, retains the full body, and reserves user color for a real quote',
  kind => {
    const payload = { ...basePayload, display_kind: kind }
    const huge = body + 'detailed worker evidence\n'.repeat(800) + 'END_OF_FULL_REPORT'
    const message = toTranscriptMessages([{ role: 'user', ...payload, text: huge }])[0]!
    const collapsed = renderToScreen(<MessageLine cols={100} msg={message} t={DEFAULT_THEME} />, 100)
    expect(collapsed.height).toBe(3)

    const stylesFor = (screen: Screen, char: string) => {
      const index = Array.from({ length: screen.width * screen.height }, (_, i) => cellAtIndex(screen, i).char).indexOf(
        char
      )

      expect(index).toBeGreaterThanOrEqual(0)

      // renderToScreen shares its style pool across calls: IDs compare actual
      // terminal styles, without testing component props or source code.
      return cellAtIndex(screen, index).styleId
    }

    const neutral = renderToScreen(<Text color={DEFAULT_THEME.color.muted}>◈</Text>, 100)
    expect(stylesFor(collapsed.screen, '◈')).toEqual(stylesFor(neutral.screen, '◈'))
    const [human] = toTranscriptMessages([{ role: 'user', text: body }])
    const quote = renderToScreen(<MessageLine cols={100} msg={human!} t={DEFAULT_THEME} />, 100)
    const gold = renderToScreen(<Text color={DEFAULT_THEME.color.label}>[</Text>, 100)
    expect(stylesFor(quote.screen, '[')).toEqual(stylesFor(gold.screen, '['))
    expect(human?.jobNotice).toBeUndefined()
    $expandedJobNotices.set(new Set([message.jobNotice!.id]))
    const expanded = renderToScreen(<MessageLine cols={100} msg={message} t={DEFAULT_THEME} />, 100)

    const text = Array.from(
      { length: expanded.screen.width * expanded.screen.height },
      (_, i) => cellAtIndex(expanded.screen, i).char
    ).join('')

    expect(expanded.height).toBeGreaterThan(800)
    expect(text).toContain('END_OF_FULL_REPORT')
    expect(message.jobNotice?.body).toBe(huge)
  }
)

it('process live replay isolates foreign sessions, simultaneous notices, human quotes and unknown kinds', () => {
  const history = { items: [] as Msg[] }
  const onEvent = createGatewayEventHandler(liveContext(history) as any)
  const payload = { ...basePayload, display_kind: 'process_complete' }
  onEvent({ session_id: 'foreign', type: 'message.start', payload })
  expect(history.items).toHaveLength(0)
  const second = { ...payload, display_metadata: { ...payload.display_metadata, notice_id: 'process:second' } }

  for (const item of [payload, second, payload]) {
    onEvent({ session_id: 'owner', type: 'message.start', payload: item })
  }

  expect(history.items.map(msg => msg.jobNotice?.id)).toEqual([payload.display_metadata.notice_id, 'process:second'])

  for (const display_kind of [undefined, 'unknown_process_complete']) {
    const [human] = toTranscriptMessages([
      { role: 'user', text: body, display_kind, display_metadata: payload.display_metadata }
    ])

    expect(human).toEqual({ role: 'user', text: body })
    history.items = appendTranscriptMessage(history.items, human!)
  }

  expect(history.items).toHaveLength(4)
})
