import { PassThrough } from 'node:stream'

import { AlternateScreen, Box, renderSync, Text } from '@hermes/ink'
import { useStore } from '@nanostores/react'
import React, { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Only resolve the native source: do not mock input, focus, rendering or hit testing.
vi.mock('@hermes/ink', async () => import('../../packages/hermes-ink/src/entry-exports.js'))

import instances from '../../packages/hermes-ink/src/ink/instances.js'
import { renderToScreen } from '../../packages/hermes-ink/src/ink/render-to-screen.js'
import { cellAtIndex, type Screen } from '../../packages/hermes-ink/src/ink/screen.js'
import { getInputSelection } from '../app/inputSelectionStore.js'
import type { InputHandlerContext } from '../app/interfaces.js'
import { $expandedJobNotices } from '../app/internalJobNoticeStore.js'
import { $isBlocked, patchOverlayState, resetOverlayState } from '../app/overlayStore.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import { useInputHandlers } from '../app/useInputHandlers.js'
import { PromptZone } from '../components/appOverlays.js'
import { MessageLine } from '../components/messageLine.js'
import { TextInput } from '../components/textInput.js'
import { toTranscriptMessages } from '../domain/messages.js'
import { DEFAULT_VOICE_RECORD_KEY } from '../lib/platform.js'
import { DEFAULT_THEME } from '../theme.js'
import type { Msg } from '../types.js'

const notice = (id: string, title = `Completed ${id}`, body = 'worker evidence\nEND_OF_REPORT'): Msg =>
  toTranscriptMessages([
    {
      role: 'user',
      text: body,
      display_kind: 'async_delegation_complete',
      display_metadata: { notice_id: id, display_text: title }
    }
  ])[0]!

beforeEach(() => {
  $expandedJobNotices.set(new Set())
  resetUiState()
  resetOverlayState()
  patchUiState({ sid: 'A' })
})
afterEach(resetOverlayState)

interface FixtureOptions {
  input?: string
  completions?: { text: string }[]
}

function makeFixture({ input: initial = 'draft', completions = [] }: FixtureOptions = {}) {
  const submit = vi.fn(),
    change = vi.fn(),
    rpc = vi.fn(async () => ({ value: '1' }))

  const approval = vi.fn(),
    clarify = vi.fn(),
    sudo = vi.fn()

  function Harness() {
    const [input, setInput] = useState(initial)
    const blocked = useStore($isBlocked)
    useInputHandlers({
      actions: { sys: vi.fn() },
      composer: {
        actions: { setInput, clearIn: () => setInput(''), pushHistory: vi.fn() },
        refs: { queueRef: { current: [] } },
        state: { input, inputBuf: [], completions, compIdx: 0, compReplace: 0, historyIdx: null, queueEditIdx: null }
      },
      gateway: { rpc },
      terminal: { hasSelection: false, scrollRef: { current: null }, selection: {} },
      voice: { enabled: false, recordKey: DEFAULT_VOICE_RECORD_KEY },
      wheelStep: 3
    } as unknown as InputHandlerContext)

    return (
      <AlternateScreen>
        <Box flexDirection="column" height={40}>
          <MessageLine cols={100} msg={notice('a')} t={DEFAULT_THEME} />
          <MessageLine cols={100} msg={notice('b')} t={DEFAULT_THEME} />
          <PromptZone
            cols={100}
            onApprovalChoice={approval}
            onClarifyCancel={() => {}}
            onClarifyQuestionAnswer={clarify}
            onSecretSubmit={() => {}}
            onSudoSubmit={sudo}
            onVaultCodeSubmit={() => {}}
            onVaultSaveLoginSubmit={() => {}}
            onVaultUnlockSubmit={() => {}}
          />
          {!blocked && (
            <TextInput
              columns={100}
              onChange={value => {
                change(value)
                setInput(value)
              }}
              onSubmit={submit}
              value={input}
            />
          )}
        </Box>
      </AlternateScreen>
    )
  }

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })
  stdout.on('data', () => {})

  const view = renderSync(<Harness />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    patchConsole: false
  })

  const ink = instances.get(stdout as unknown as NodeJS.WriteStream)!
  // AlternateScreen uses process.stdout; activate this fixture's own native instance.
  ink.setAltScreenActive(true)

  const lines = () => {
    const screen = (ink as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen

    return Array.from({ length: screen.height }, (_, y) =>
      Array.from({ length: screen.width }, (_, x) => cellAtIndex(screen, y * screen.width + x).char)
        .join('')
        .trimEnd()
    )
  }

  const mouse = (x: number, y: number, button: number, action: 'M' | 'm') =>
    `\x1b[<${button};${x + 1};${y + 1}${action}`

  return {
    ink,
    stdin,
    submit,
    change,
    rpc,
    approval,
    clarify,
    sudo,
    lines,
    text: () => lines().join('\n'),
    click: (x: number, y: number) => stdin.write(mouse(x, y, 0, 'M') + mouse(x, y, 0, 'm')),
    drag: (from: number, to: number, y: number) =>
      stdin.write(mouse(from, y, 0, 'M') + mouse(to, y, 32, 'M') + mouse(to, y, 0, 'm')),
    // A single write is essential: no render/effect wait between parsed keys.
    burst: async (keys: string) => {
      stdin.write(keys)
      await new Promise(resolve => setTimeout(resolve, 80))
    },
    close: () => {
      view.unmount()
      view.cleanup()
    }
  }
}

type Fixture = ReturnType<typeof makeFixture>

async function withFixture(run: (h: Fixture) => Promise<void>, options?: FixtureOptions) {
  const h = makeFixture(options)

  try {
    await vi.waitFor(() => expect(h.text()).toContain('Expand details'))
    await run(h)
  } finally {
    h.close()
  }
}

it('clicking back into composer relinquishes notice keys and preserves the draft', () =>
  withFixture(async h => {
    h.click(
      3,
      h.lines().findIndex(line => line.includes('Expand details'))
    )
    await vi.waitFor(() => expect(h.text()).toContain('Collapse details'))
    h.click(
      4,
      h.lines().findIndex(line => line.includes('draft'))
    )
    await h.burst('x ')
    await h.burst('\r')
    expect(h.ink.focusManager.activeElement).toBeNull()
    expect(h.change.mock.calls, JSON.stringify(h.change.mock.calls)).toContainEqual(['drafx t'])
    expect(h.submit).toHaveBeenCalledExactlyOnceWith('drafx t')
    expect([...$expandedJobNotices.get()]).toEqual(['a'])
  }))

it('composer drag selection restores ownership without changing the draft or expanding a notice', () =>
  withFixture(async h => {
    h.click(
      3,
      h.lines().findIndex(line => line.includes('Expand details'))
    )
    await vi.waitFor(() => expect(h.text()).toContain('Collapse details'))
    h.drag(
      1,
      4,
      h.lines().findIndex(line => line.includes('draft'))
    )
    await vi.waitFor(() => expect(getInputSelection()).toMatchObject({ start: 1, end: 4, value: 'draft' }))
    expect(h.ink.focusManager.activeElement).toBeNull()
    expect(h.change).not.toHaveBeenCalled()
    expect([...$expandedJobNotices.get()]).toEqual(['a'])
    await h.burst('X')
    await h.burst('\r')
    expect(h.submit).toHaveBeenCalledExactlyOnceWith('dXt')
    expect([...$expandedJobNotices.get()]).toEqual(['a'])
  }))

it('rapid Tab+Enter does not send a draft instead of toggling the focused card', () =>
  withFixture(async h => {
    await h.burst('\t\r')
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.change).not.toHaveBeenCalled()
    expect([...$expandedJobNotices.get()]).toEqual(['a'])
  }))

it('rapid focus-next+Space targets the newly focused card only', () =>
  withFixture(async h => {
    await h.burst('\t')
    await h.burst('\t ')
    expect([...$expandedJobNotices.get()]).toEqual(['b'])
    expect(h.change).not.toHaveBeenCalled()
    expect(h.submit).not.toHaveBeenCalled()
  }))

it('rapid Esc then Enter returns input immediately to composer', () =>
  withFixture(async h => {
    await h.burst('\t')
    // CSI-u Escape is unambiguous; bare ESC+CR is also Alt+Enter's encoding.
    await h.burst('\x1b[27u\r')
    expect(h.submit).toHaveBeenCalledExactlyOnceWith('draft')
    expect(h.ink.focusManager.activeElement).toBeNull()
    expect($expandedJobNotices.get().size).toBe(0)
  }))

it('Shift+Tab notice navigation must not change approval bypass via the real global handler', () =>
  withFixture(async h => {
    await h.burst('\t')
    const first = h.ink.focusManager.activeElement
    await h.burst('\t')
    expect(h.ink.focusManager.activeElement).not.toBe(first)
    await h.burst('\x1b[Z')
    expect(h.ink.focusManager.activeElement).toBe(first)
    expect(h.rpc).not.toHaveBeenCalled()
  }))

it('rapid forward/reverse navigation activates only the final current owner', () =>
  withFixture(async h => {
    await h.burst('\t\t\x1b[Z ')
    expect([...$expandedJobNotices.get()]).toEqual(['a'])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.change).not.toHaveBeenCalled()
    expect(h.submit).not.toHaveBeenCalled()
  }))

it('composer-side Shift+Tab keeps its intentional YOLO shortcut without moving focus', () =>
  withFixture(async h => {
    await h.burst('\x1b[Z')
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('config.set', { key: 'yolo', session_id: 'A' })
    expect(h.ink.focusManager.activeElement).toBeNull()
    await h.burst('\r')
    expect(h.submit).toHaveBeenCalledExactlyOnceWith('draft')
  }))

it('composer Tab autocomplete must not give the next Enter to a notice', () =>
  withFixture(
    async h => {
      await h.burst('\t')
      await vi.waitFor(() => expect(h.text()).toContain('/help'))
      expect(h.ink.focusManager.activeElement).toBeNull()
      await h.burst('\r')
      expect(h.submit).toHaveBeenCalledExactlyOnceWith('/help')
      expect($expandedJobNotices.get().size).toBe(0)
    },
    { input: '/he', completions: [{ text: '/help' }] }
  ))

it('focused notice navigation takes priority over an available composer completion', () =>
  withFixture(
    async h => {
      h.click(
        3,
        h.lines().findIndex(line => line.includes('Expand details'))
      )
      await vi.waitFor(() => expect(h.text()).toContain('Collapse details'))
      await h.burst('\t\x1b[Z')
      expect(h.text()).toContain('/he')
      expect(h.text()).not.toContain('/help')
      expect(h.rpc).not.toHaveBeenCalled()
      expect([...$expandedJobNotices.get()]).toEqual(['a'])
    },
    { input: '/he', completions: [{ text: '/help' }] }
  ))

it('CSI-u Space activates the native focused notice, not the composer', () =>
  withFixture(async h => {
    await h.burst('\t\x1b[32u')
    expect([...$expandedJobNotices.get()]).toEqual(['a'])
    expect(h.change).not.toHaveBeenCalled()
  }))

it.each([
  ['Ctrl+Space', '\x1b[32;5u'],
  ['Alt+Space', '\x1b[32;3u'],
  ['Super+Space', '\x1b[32;9u'],
  ['Shift+Return', '\x1b[13;2u'],
  ['Ctrl+Tab', '\x1b[9;5u'],
  ['Super+Tab', '\x1b[9;9u'],
  ['pasted Space', '\x1b[200~ \x1b[201~'],
  ['pasted Tab/Return', '\x1b[200~\t\r\x1b[201~']
])('%s never activates a notice or changes native focus', (_name, keys) =>
  withFixture(async h => {
    await h.burst('\t')
    const focused = h.ink.focusManager.activeElement
    await h.burst(keys)
    expect(h.ink.focusManager.activeElement).toBe(focused)
    expect($expandedJobNotices.get().size).toBe(0)
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })
)

it.each(['approval', 'clarify', 'sudo'] as const)('real %s prompt takes keys from a previously focused notice', kind =>
  withFixture(async h => {
    await h.burst('\t')

    const request =
      kind === 'approval'
        ? { requestId: 'r', command: 'fixture safe text', description: 'Review decision' }
        : kind === 'clarify'
          ? { requestId: 'r', questions: [{ qid: 'q', question: 'Choose fixture', choices: ['One', 'Two'] }] }
          : { requestId: 'r', prompt: 'Password' }

    patchOverlayState({ [kind]: request } as any)
    await vi.waitFor(() =>
      expect(h.text()).toContain(
        kind === 'approval' ? 'fixture safe text' : kind === 'clarify' ? 'Choose fixture' : 'password'
      )
    )
    await h.burst('\t\r')
    expect(kind === 'approval' ? h.approval : kind === 'clarify' ? h.clarify : h.sudo).toHaveBeenCalledOnce()
    expect($expandedJobNotices.get().size).toBe(0)
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.change).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })
)

it('does not accept ANSI colors from a goal in collapsed metadata', () => {
  const title = 'Subagent Task Completed: \x1b[33mFORGED\x1b[0m'
  const msg = notice('ansi', title)
  const frame = renderToScreen(<MessageLine cols={100} msg={msg} t={DEFAULT_THEME} />, 100)
  const cells = Array.from({ length: frame.screen.width * frame.screen.height }, (_, i) => cellAtIndex(frame.screen, i))

  const neutral = renderToScreen(
    <Text color={DEFAULT_THEME.color.muted as React.ComponentProps<typeof Text>['color']}>F</Text>,
    100
  )

  expect(cells.find(c => c.char === 'F')!.styleId).toBe(cellAtIndex(neutral.screen, 0).styleId)
  expect(msg.text).toBe(title)
})

it('expanded report strips terminal controls without changing the stored payload', () => {
  const body = 'before\x1b[31mRED\x1b[0m\x1b]52;c;dGVzdA==\x07\x1b[2J\x00\nafter'
  const msg = notice('controls', 'Completed', body)
  $expandedJobNotices.set(new Set(['controls']))
  const frame = renderToScreen(<MessageLine cols={100} msg={msg} t={DEFAULT_THEME} />, 100)

  const output = Array.from(
    { length: frame.screen.width * frame.screen.height },
    (_, i) => cellAtIndex(frame.screen, i).char
  ).join('')

  expect(output).toContain('beforeRED')
  expect(output).toContain('after')
  expect(output).not.toContain('dGVzdA==')
  expect(msg.jobNotice?.body).toBe(body)
})

it('malformed/unknown display kinds never gain an internal control', () => {
  for (const kind of [undefined, null, {}, 'ASYNC DELEGATION', 'Async_delegation_complete']) {
    const [msg] = toTranscriptMessages([
      {
        role: 'user',
        text: '[ASYNC DELEGATION COMPLETE]\nhuman',
        display_kind: kind,
        display_metadata: { notice_id: 'a' }
      }
    ])

    expect(msg?.role).toBe('user')
    expect(msg?.jobNotice).toBeUndefined()
  }
})
