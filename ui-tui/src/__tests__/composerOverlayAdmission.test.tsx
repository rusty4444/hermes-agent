import { PassThrough } from 'node:stream'

import { AlternateScreen, Box, renderSync } from '@hermes/ink'
import { useStore } from '@nanostores/react'
import React, { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@hermes/ink', async () => import('../../packages/hermes-ink/src/entry-exports.js'))

import instances from '../../packages/hermes-ink/src/ink/instances.js'
import { cellAtIndex, type Screen } from '../../packages/hermes-ink/src/ink/screen.js'
import { $expandedJobNotices } from '../app/internalJobNoticeStore.js'
import { $isBlocked, patchOverlayState, resetOverlayState } from '../app/overlayStore.js'
import { turnController } from '../app/turnController.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import { useInputHandlers } from '../app/useInputHandlers.js'
import { useSubmission } from '../app/useSubmission.js'
import { PromptZone } from '../components/appOverlays.js'
import { MessageLine } from '../components/messageLine.js'
import { TextInput } from '../components/textInput.js'
import { toTranscriptMessages } from '../domain/messages.js'
import { DEFAULT_VOICE_RECORD_KEY } from '../lib/platform.js'
import { DEFAULT_THEME } from '../theme.js'

beforeEach(() => {
  resetUiState()
  resetOverlayState()
  turnController.fullReset()
  $expandedJobNotices.set(new Set())
  patchUiState({ sid: 'owner', busy: true, busyInputMode: 'queue' })
})
afterEach(() => {
  turnController.fullReset()
  resetOverlayState()
})

const requests = {
  approval: { requestId: 'decision', command: 'fixture command', description: 'Review fixture' },
  clarify: { requestId: 'question', questions: [{ qid: 'q', question: 'Choose fixture', choices: ['One', 'Two'] }] },
  sudo: { requestId: 'credential', prompt: 'Password' }
}

function mount(initial = 'draft', completions: { text: string }[] = []) {
  const enqueue = vi.fn(),
    pushHistory = vi.fn(),
    clear = vi.fn(),
    change = vi.fn(),
    setInputBuf = vi.fn(),
    slash = vi.fn(),
    appendMessage = vi.fn()

  const request = vi.fn(async () => ({})),
    rpc = vi.fn(async () => null),
    decision = vi.fn()

  let submission: ReturnType<typeof useSubmission>
  let draft = initial

  function Tree() {
    const [input, setInput] = useState(initial)
    draft = input
    const blocked = useStore($isBlocked)
    const state = { input, inputBuf: [], completions, compIdx: 0, compReplace: 0, historyIdx: null, queueEditIdx: null }
    const refs = { tokensRef: { current: [] }, queueRef: { current: [] }, queueEditRef: { current: null } }

    const actions = {
      setInput: (value: string) => {
        change(value)
        setInput(value)
      },
      setInputBuf,
      clearIn: () => {
        clear()
        setInput('')
      },
      enqueue,
      pushHistory
    }

    const gw = { request }
    submission = useSubmission({
      appendMessage,
      composerActions: actions,
      composerRefs: refs,
      composerState: state,
      gw,
      setLastUserMsg: vi.fn(),
      slashRef: { current: slash },
      submitRef: { current: vi.fn() },
      sys: vi.fn()
    } as any)
    useInputHandlers({
      actions: { sys: vi.fn(), appendMessage, dispatchSubmission: submission.dispatchSubmission },
      composer: { actions, refs, state },
      gateway: { rpc, gw },
      terminal: { hasSelection: false, scrollRef: { current: null }, selection: {} },
      voice: { enabled: false, recordKey: DEFAULT_VOICE_RECORD_KEY },
      wheelStep: 3
    } as any)

    return (
      <AlternateScreen>
        <Box flexDirection="column" height={40}>
          <MessageLine
            cols={100}
            msg={
              toTranscriptMessages([
                {
                  role: 'user',
                  text: 'worker evidence',
                  display_kind: 'async_delegation_complete',
                  display_metadata: { notice_id: 'delegation:fixture', display_text: 'Background Agent Finished' }
                }
              ])[0]!
            }
            t={DEFAULT_THEME}
          />
          <PromptZone
            cols={100}
            onApprovalChoice={decision}
            onClarifyCancel={() => {}}
            onClarifyQuestionAnswer={decision}
            onSecretSubmit={() => {}}
            onSudoSubmit={decision}
            onVaultCodeSubmit={() => {}}
            onVaultSaveLoginSubmit={() => {}}
            onVaultUnlockSubmit={() => {}}
          />
          {!blocked && (
            <TextInput columns={100} onChange={actions.setInput} onSubmit={submission.submit} value={input} />
          )}
        </Box>
      </AlternateScreen>
    )
  }

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
  stdout.on('data', () => {})

  const view = renderSync(<Tree />, {
    stdout: stdout as any,
    stdin: stdin as any,
    stderr: new PassThrough() as any,
    patchConsole: false,
    exitOnCtrlC: false
  })

  const ink = instances.get(stdout as any)!
  ink.setAltScreenActive(true)

  const lines = () => {
    const screen: Screen = (ink as any).frontFrame.screen

    return Array.from({ length: screen.height }, (_, y) =>
      Array.from({ length: screen.width }, (_, x) => cellAtIndex(screen, y * screen.width + x).char)
        .join('')
        .trimEnd()
    )
  }

  return {
    ink,
    stdin,
    enqueue,
    pushHistory,
    clear,
    change,
    setInputBuf,
    slash,
    appendMessage,
    request,
    rpc,
    decision,
    lines,
    draft: () => draft,
    submission: () => submission,
    close: () => {
      view.unmount()
      view.cleanup()
    }
  }
}

function expectNoSubmission(h: ReturnType<typeof mount>) {
  for (const effect of [
    h.enqueue,
    h.pushHistory,
    h.clear,
    h.change,
    h.setInputBuf,
    h.slash,
    h.appendMessage,
    h.request,
    h.rpc
  ]) {
    expect(effect).not.toHaveBeenCalled()
  }

  expect($expandedJobNotices.get().size).toBe(0)
}

it.each(['approval', 'clarify', 'sudo'] as const)(
  'an immediate %s handoff blocks the real composer pipeline but leaves the visible prompt usable',
  async kind => {
    const h = mount()

    try {
      await vi.waitFor(() => expect(h.lines().join('\n')).toContain('Expand details'))
      h.stdin.write('\t')
      await vi.waitFor(() => expect(h.ink.focusManager.activeElement).toBeTruthy())
      patchOverlayState({ [kind]: requests[kind] })
      // No render/effect wait between the store write and native Return.
      h.stdin.write('\r')
      await vi.waitFor(() =>
        expect(h.lines().join('\n')).toContain(
          kind === 'approval' ? 'fixture command' : kind === 'clarify' ? 'Choose fixture' : 'password'
        )
      )
      expectNoSubmission(h)
      expect(h.draft()).toBe('draft')
      expect(h.decision).not.toHaveBeenCalled()
      h.stdin.write('\r')
      await vi.waitFor(() => expect(h.decision).toHaveBeenCalledOnce())
      expectNoSubmission(h)
      resetOverlayState()
      await vi.waitFor(() => expect(h.lines().join('\n')).toContain('draft'))
      expect(h.draft()).toBe('draft')
    } finally {
      h.close()
    }
  }
)

it.each(['approval', 'clarify', 'sudo'] as const)(
  'immediate %s handoff cannot leak reverse notice navigation into the composer YOLO shortcut',
  async kind => {
    const h = mount()

    try {
      await vi.waitFor(() => expect(h.lines().join('\n')).toContain('Expand details'))
      h.stdin.write('\t')
      await vi.waitFor(() => expect(h.ink.focusManager.activeElement).toBeTruthy())
      patchOverlayState({ [kind]: requests[kind] })
      h.stdin.write('\x1b[Z\r')
      await vi.waitFor(() => expect(h.lines().join('\n')).not.toContain('Expand details · Esc: composer'))
      expectNoSubmission(h)
      expect(h.draft()).toBe('draft')
    } finally {
      h.close()
    }
  }
)

it.each(['draft', '/queue draft', '!fixture-command', '$(fixture-command)', 'draft\\'])(
  'direct composer entry rejects %s before history, clear, slash, shell, interpolation or queue effects',
  async draft => {
    const h = mount(draft)

    try {
      await vi.waitFor(() => expect(h.lines().join('\n')).toContain('Expand details'))
      patchOverlayState({ approval: requests.approval })
      h.submission().submit(draft)
      h.submission().dispatchSubmission(draft)
      expectNoSubmission(h)
      expect(h.draft()).toBe(draft)
    } finally {
      h.close()
    }
  }
)

it('a pending overlay also blocks completion acceptance before it edits the draft', async () => {
  const h = mount('/he', [{ text: '/help' }])

  try {
    await vi.waitFor(() => expect(h.lines().join('\n')).toContain('/he'))
    patchOverlayState({ clarify: requests.clarify })
    h.submission().submit('/he')
    expectNoSubmission(h)
    expect(h.draft()).toBe('/he')
  } finally {
    h.close()
  }
})

it('raw composer pointer return and paced edit still submit exactly once through the real queue', async () => {
  const h = mount()

  try {
    await vi.waitFor(() => expect(h.lines().join('\n')).toContain('Expand details'))
    h.stdin.write('\t')
    await vi.waitFor(() => expect(h.ink.focusManager.activeElement).toBeTruthy())
    const y = h.lines().findIndex(line => line.includes('draft')) + 1
    h.stdin.write(`\x1b[<0;6;${y}M\x1b[<0;6;${y}m`)
    await vi.waitFor(() => expect(h.ink.focusManager.activeElement).toBeNull())
    h.stdin.write(' ')
    // Only printable text is paced: the parser intentionally treats printable
    // multiline input as paste. Focus bursts above are single native writes.
    await vi.waitFor(() => expect(h.draft()).toBe('draft '))
    h.stdin.write('\r')
    await vi.waitFor(() => expect(h.enqueue).toHaveBeenCalledExactlyOnceWith('draft ', 'draft '))
    expect(h.pushHistory).toHaveBeenCalledExactlyOnceWith('draft')
    expect(h.clear).toHaveBeenCalledOnce()
    expect(h.request).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  } finally {
    h.close()
  }
})
