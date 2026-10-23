import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { AlternateScreen, Box, renderSync } from '@hermes/ink'
import { JsonRpcRequestChannel, type ServerRequest } from '@hermes/shared/json-rpc-channel'
import { useStore } from '@nanostores/react'
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@hermes/ink', async () => import('../../packages/hermes-ink/src/entry-exports.js'))
vi.mock('../hooks/useGitBranch.js', () => ({ useGitBranch: () => null }))
vi.mock('../lib/clipboard.js', () => ({
  readClipboardText: vi.fn(async () => ''),
  writeClipboardText: vi.fn(async () => true)
}))

import instances from '../../packages/hermes-ink/src/ink/instances.js'
import { cellAtIndex, type Screen } from '../../packages/hermes-ink/src/ink/screen.js'
import { $isBlocked, $overlayState, getOverlayState, resetOverlayState } from '../app/overlayStore.js'
import { getServerRequest, resetServerRequestsForTests } from '../app/serverRequestStore.js'
import { turnController } from '../app/turnController.js'
import { getUiState, patchUiState, resetUiState } from '../app/uiStore.js'
import { useMainApp } from '../app/useMainApp.js'
import { PromptZone } from '../components/appOverlays.js'
import { TextInput } from '../components/textInput.js'

beforeEach(() => {
  resetUiState()
  resetOverlayState()
  turnController.fullReset()
  resetServerRequestsForTests()
  patchUiState({ sid: 'runtime-A', storedSid: 'durable-A', busy: true })
})
afterEach(() => {
  turnController.fullReset()
  resetOverlayState()
  resetServerRequestsForTests()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

const flush = async () => {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

interface Frame {
  id: string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

// Transport and unrelated OS work are fixtures. The channel, listener,
// lifecycle, request instances, native parser, PromptZone and composer are real.
function mountReplayApp() {
  const frames: Frame[] = []
  const received: ServerRequest[] = []
  const holds = new Map<string, ReturnType<typeof deferred<void>>>()
  let lock: ReturnType<typeof deferred<unknown>> | undefined
  let onArrival: ((request: ServerRequest) => void) | undefined
  let setup: unknown = { provider_configured: true }

  const gateway = Object.assign(new EventEmitter(), {
    request: vi.fn(async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === 'setup.status') {
        return setup
      }

      if (method === 'clarify.lock') {
        return lock ? lock.promise : { status: 'ok', remaining: [] }
      }

      if (!['session.activate', 'session.resume', 'session.create'].includes(method)) {
        return null
      }

      const result = await channel.request(method, params)
      await holds.get(String(params.session_id ?? 'create'))?.promise

      return result
    }),
    drain: vi.fn(),
    start: vi.fn(),
    kill: vi.fn(),
    notify: vi.fn(),
    getLogTail: () => []
  })

  const channel = new JsonRpcRequestChannel({
    requestTimeoutMs: 0,
    onEvent: event => gateway.emit('event', event)
  })

  channel.attach({ send: text => frames.push(JSON.parse(text) as Frame) })
  channel.onRequest(request => {
    received.push(request)
    gateway.emit('request', request)
    onArrival?.(request)

    return true
  })

  let app!: ReturnType<typeof useMainApp>

  function Tree() {
    app = useMainApp(gateway as never)
    const blocked = useStore($isBlocked)
    const a = app.appActions

    return (
      <AlternateScreen>
        <Box flexDirection="column" height={42}>
          <PromptZone
            cols={110}
            onApprovalChoice={a.answerApproval}
            onClarifyCancel={a.cancelClarify}
            onClarifyQuestionAnswer={a.answerClarifyQuestion}
            onSecretSubmit={a.answerSecret}
            onSudoSubmit={a.answerSudo}
            onVaultCodeSubmit={a.answerVaultCode}
            onVaultSaveLoginSubmit={a.answerVaultSaveLogin}
            onVaultUnlockSubmit={a.answerVaultUnlock}
          />
          {!blocked && (
            <TextInput
              onChange={app.appComposer.updateInput}
              onPaste={app.appComposer.handleTextPaste}
              onSubmit={app.appComposer.submit}
              value={app.appComposer.input}
            />
          )}
        </Box>
      </AlternateScreen>
    )
  }

  const stdout = Object.assign(new PassThrough(), { columns: 110, rows: 42, isTTY: false })
  stdout.on('data', () => {})
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} })

  const view = renderSync(<Tree />, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new PassThrough() as never,
    patchConsole: false,
    exitOnCtrlC: false
  })

  const ink = instances.get(stdout as never)!
  ink.setAltScreenActive(true)

  const text = () => {
    const s: Screen = (ink as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen

    return Array.from({ length: s.height }, (_, y) =>
      Array.from({ length: s.width }, (_, x) => cellAtIndex(s, y * s.width + x).char).join('')
    ).join('\n')
  }

  const live = (method: string, id: string, sid: string, params = {}) => {
    channel.handleFrame(JSON.stringify({ jsonrpc: '2.0', id, method, params: { session_id: sid, ...params } }))

    return received.at(-1)!
  }

  const cancel = (sid: string, id: string) =>
    channel.handleFrame(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'request.cancel', session_id: sid, payload: { id, reason: 'timeout' } }
      })
    )

  return {
    app: () => app,
    gateway,
    channel,
    frames,
    received,
    stdin,
    text,
    live,
    cancel,
    onArrival: (action: typeof onArrival) => {
      onArrival = action
    },
    setup: (value: unknown) => {
      setup = value
    },
    hold: (id: string) => {
      const gate = deferred<void>()
      holds.set(id, gate)

      return gate
    },
    holdLock: () => {
      lock = deferred<unknown>()

      return lock
    },
    call: async (method: string, sid?: string) => {
      await vi.waitFor(() =>
        expect(frames.some(f => f.method === method && (!sid || f.params?.session_id === sid))).toBe(true)
      )

      return frames.findLast(f => f.method === method && (!sid || f.params?.session_id === sid))!
    },
    reply: (call: Frame, result: unknown) =>
      channel.handleFrame(JSON.stringify({ jsonrpc: '2.0', id: call.id, result })),
    fail: (call: Frame) =>
      channel.handleFrame(
        JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: 4001, message: 'Synthetic failure' } })
      ),
    close: () => {
      for (const hold of holds.values()) {
        hold.resolve()
      }

      lock?.resolve(null)
      channel.detach(new Error('Fixture teardown'))
      view.unmount()
      view.cleanup()
    }
  }
}

interface PromptCase {
  method: string
  key: 'approval' | 'clarify' | 'sudo' | 'secret' | 'vaultUnlock' | 'vaultSaveLogin' | 'vaultCode'
  label: string
  params: Record<string, unknown>
}

const promptCases: PromptCase[] = [
  {
    method: 'approval',
    key: 'approval',
    label: 'REPLAY_COMMAND',
    params: { command: 'REPLAY_COMMAND', description: 'Review' }
  },
  {
    method: 'clarify',
    key: 'clarify',
    label: 'REPLAY_QUESTION',
    params: { questions: [{ qid: 'q', question: 'REPLAY_QUESTION', choices: ['One', 'Two'] }] }
  },
  { method: 'sudo', key: 'sudo', label: 'password', params: {} },
  {
    method: 'secret',
    key: 'secret',
    label: 'REPLAY_SECRET',
    params: { env_var: 'SYNTHETIC_ONLY', prompt: 'REPLAY_SECRET' }
  },
  {
    method: 'vault.unlock_prompt',
    key: 'vaultUnlock',
    label: 'Unlock Fixture',
    params: { backend: 'fixture', display_name: 'Fixture' }
  },
  {
    method: 'vault.save_login',
    key: 'vaultSaveLogin',
    label: 'Save your Fixture login',
    params: { site: 'Fixture', origin: 'https://fixture.invalid' }
  },
  {
    method: 'vault.code',
    key: 'vaultCode',
    label: 'Verification code for Fixture',
    params: { site: 'Fixture', hint: 'Synthetic only' }
  }
]

const snapshot = (h: ReturnType<typeof mountReplayApp>) => ({
  input: h.app().appComposer.input,
  inputBuf: [...h.app().appComposer.inputBuf],
  queue: [...h.app().appComposer.queuedDisplay]
})

const payload = (sid: string, requests: unknown[] = []) => ({
  session_id: sid,
  session_key: `durable-${sid}`,
  stored_session_id: `durable-${sid}`,
  status: 'waiting',
  running: true,
  messages: [],
  open_requests: requests
})

const replay = (test: PromptCase, sid = 'runtime-B', id = 'reused') => ({
  id,
  method: test.method,
  params: { session_id: sid, ...test.params }
})

for (const operation of ['activate', 'resume'] as const) {
  it.each(promptCases)(
    `${operation} keeps the real $method replay visible, blocking and freshly answerable`,
    async test => {
      const h = mountReplayApp()

      let stop = () => {}

      let stopCards = () => {}

      try {
        h.app().appComposer.updateInput('UNSENT_REPLAY_DRAFT')
        await vi.waitFor(() => expect(h.text()).toContain('UNSENT_REPLAY_DRAFT'))
        const before = snapshot(h)
        const old = h.live('approval', 'reused', 'runtime-A', { command: 'OLD_COMMAND' })
        await vi.waitFor(() => expect(h.text()).toContain('OLD_COMMAND'))
        const stale = h.app().appActions.answerApproval

        if (operation === 'activate') {
          h.app().appActions.activateLiveSession('picker-B')
        } else {
          patchUiState({ busy: false })
          h.app().appActions.resumeById('durable-B')
        }

        const call = await h.call(`session.${operation}`)
        const blocks: boolean[] = []
        stop = $isBlocked.listen(value => blocks.push(value))
        const cards: unknown[] = []
        stopCards = $overlayState.listen(overlay => {
          if (getServerRequest('reused')?.params.session_id === 'runtime-B') {
            cards.push(overlay[test.key])
          }
        })
        h.onArrival(() => h.stdin.write('\x1b[13u')) // before result/React continuation
        h.reply(call, payload('runtime-B', [replay(test)]))
        h.onArrival(undefined)
        stale('once')
        await vi.waitFor(() => expect(getUiState().sid).toBe('runtime-B'))
        await vi.waitFor(() => expect(h.text()).toContain(test.label))
        await flush()
        stop()
        stopCards()
        expect(blocks).not.toContain(false)
        expect(cards.length).toBeGreaterThan(0)
        expect(cards.every(card => card === cards[0] && card !== null)).toBe(true)
        const actual = h.received.at(-1)!
        expect(actual).not.toBe(old)
        expect(getServerRequest('reused')).toBe(actual)
        expect(getOverlayState()[test.key]?.requestId).toBe('reused')
        expect($isBlocked.get()).toBe(true)
        expect(snapshot(h)).toEqual(before)
        expect(h.frames.some(f => f.id === 'reused')).toBe(false)
        expect(h.gateway.request.mock.calls.filter(([m]) => m === 'clarify.lock')).toHaveLength(0)

        if (test.method === 'approval' || test.method === 'clarify') {
          h.stdin.write('\r')
        } else {
          h.stdin.write('synthetic-value')
          await vi.waitFor(() =>
            expect(h.text()).toContain(
              test.key === 'vaultCode' || test.key === 'vaultSaveLogin' ? 'synthetic-value' : '***************'
            )
          )
          h.stdin.write('\r')

          if (test.key === 'vaultSaveLogin') {
            await vi.waitFor(() => expect(h.text()).toContain('Password for synthetic-value'))
            h.stdin.write('synthetic-password')
            await vi.waitFor(() => expect(h.text()).toContain('******************'))
            h.stdin.write('\r')
          }
        }

        await vi.waitFor(() => expect(getOverlayState()[test.key]).toBeNull())

        if (test.method === 'clarify') {
          expect(h.gateway.request).toHaveBeenCalledWith('clarify.lock', {
            request_id: 'reused',
            question_id: 'q',
            answer: 'One'
          })
        } else {
          expect(h.frames.filter(f => f.id === 'reused')).toHaveLength(1)
        }

        expect(JSON.stringify(h.app().appTranscript.historyItems)).not.toContain('synthetic-')
        expect(snapshot(h)).toEqual(before)
      } finally {
        stop()
        stopCards()
        h.close()
      }
    }
  )
}

it.each(['idle', 'queue', 'steer', 'interrupt'] as const)(
  'blocks %s composer effects throughout a held adoption',
  async mode => {
    const h = mountReplayApp()

    try {
      patchUiState({ busy: mode !== 'idle', busyInputMode: mode === 'idle' ? 'queue' : mode })
      h.app().appComposer.updateInput('/help UNSENT')
      await flush()
      const before = snapshot(h)
      const history = h.app().appTranscript.historyItems
      const submit = h.app().appComposer.submit
      h.app().appActions.activateLiveSession('B')
      h.stdin.write('\r')
      submit('/help UNSENT')
      const call = await h.call('session.activate')
      await flush()
      expect(snapshot(h)).toEqual(before)
      expect(h.app().appTranscript.historyItems).toBe(history)
      expect(
        h.gateway.request.mock.calls.filter(([m]) => ['prompt.submit', 'slash.exec', 'session.interrupt'].includes(m))
      ).toHaveLength(0)
      h.reply(call, payload('runtime-B', [replay(promptCases[0])]))
      await vi.waitFor(() => expect(h.text()).toContain('REPLAY_COMMAND'))
      expect(snapshot(h)).toEqual(before)
    } finally {
      h.close()
    }
  }
)

it.each(['runtime-B', 'runtime-A'])('a later live request beats replay even when adopting %s', async sid => {
  const h = mountReplayApp()

  try {
    const gate = h.hold('B')
    h.app().appActions.activateLiveSession('B')
    const call = await h.call('session.activate')
    h.reply(call, payload(sid, [replay(promptCases[0], sid)]))
    await flush() // explicitly held wrapper, not a race-hiding timer
    const newer = h.live('approval', 'reused', sid, { command: 'NEWER_COMMAND' })
    h.stdin.write('\r')
    gate.resolve()
    await vi.waitFor(() => expect(getUiState().sid).toBe(sid))
    await vi.waitFor(() => expect(h.text()).toContain('NEWER_COMMAND'))
    expect(getServerRequest('reused')).toBe(newer)
    expect(h.frames.filter(f => f.id === 'reused')).toHaveLength(0)
    h.stdin.write('\r')
    await vi.waitFor(() => expect(h.frames.filter(f => f.id === 'reused')).toHaveLength(1))
  } finally {
    h.close()
  }
})

it.each(['before-reply', 'after-replay'] as const)(
  'latest switch wins when an obsolete same-SID replay arrives %s',
  async order => {
    const h = mountReplayApp()

    try {
      const held = h.hold('old')
      h.app().appActions.activateLiveSession('old')
      const oldCall = await h.call('session.activate', 'old')

      if (order === 'after-replay') {
        h.reply(oldCall, payload('runtime-B', [replay(promptCases[0])]))
      }

      patchUiState({ busy: false })
      h.app().appActions.resumeById('new')
      const newCall = await h.call('session.resume', 'new')
      const test = { ...promptCases[0], params: { command: 'CURRENT_COMMAND' } }
      h.reply(newCall, payload('runtime-B', [replay(test)]))
      await vi.waitFor(() => expect(h.text()).toContain('CURRENT_COMMAND'))
      const current = getServerRequest('reused')!
      const answer = vi.spyOn(current, 'respond')

      if (order === 'before-reply') {
        h.reply(oldCall, payload('runtime-B', [replay(promptCases[0])]))
      }

      held.resolve()
      h.stdin.write('\r')
      await flush()
      expect(answer).toHaveBeenCalledExactlyOnceWith({ choice: 'once' })
      expect(getServerRequest('reused')).toBeUndefined()
      expect(getUiState().sid).toBe('runtime-B')
      expect(h.app().appTranscript.historyItems.some(m => m.text.includes('REPLAY_COMMAND'))).toBe(false)
      expect(h.frames.filter(f => f.id === 'reused')).toHaveLength(1)
      expect(
        h.gateway.request.mock.calls.filter(([m, p]) => m === 'session.close' && p?.session_id === 'runtime-B')
      ).toHaveLength(0)
    } finally {
      h.close()
    }
  }
)

it.each(['error', 'malformed', 'cancelled', 'cancel-before-replay', 'wrapper-rejection'] as const)(
  'does not restore the staged prompt from a %s transition',
  async outcome => {
    const h = mountReplayApp()

    try {
      const old = h.live('approval', 'old', 'runtime-A', { command: 'OLD_COMMAND' })
      await vi.waitFor(() => expect(h.text()).toContain('OLD_COMMAND'))
      const gate = outcome === 'wrapper-rejection' ? h.hold('B') : undefined
      h.app().appActions.activateLiveSession('B')
      const call = await h.call('session.activate')

      if (outcome === 'error') {
        h.fail(call)
      } else if (outcome === 'malformed') {
        h.reply(call, { open_requests: [replay(promptCases[0])], messages: [] })
      } else {
        if (outcome === 'cancel-before-replay') {
          h.cancel('runtime-B', 'reused')
        }

        h.reply(call, payload('runtime-B', [replay(promptCases[0])]))

        if (outcome === 'cancelled') {
          h.cancel('runtime-B', 'reused')
        } else if (outcome === 'wrapper-rejection') {
          await flush()
          gate!.reject(new Error('Synthetic wrapper failure'))
        }
      }

      await flush()

      if (outcome === 'cancelled' || outcome === 'cancel-before-replay') {
        expect(getUiState().sid).toBe('runtime-B')
        expect(getOverlayState().approval).toBeNull()
        expect(getServerRequest('reused')).toBeUndefined()
      } else {
        expect(getUiState().sid).toBe('runtime-A')
        expect(getServerRequest('old')).toBe(old)
        expect(getOverlayState().approval?.command).toBe('OLD_COMMAND')
        h.stdin.write('\r')
        await vi.waitFor(() => expect(h.frames.filter(f => f.id === 'old')).toHaveLength(1))
      }

      expect(h.frames.some(f => f.id === 'reused')).toBe(false)
    } finally {
      h.close()
    }
  }
)

it('ignores foreign arrivals and cancellations, and never resurrects an answered current request', async () => {
  const h = mountReplayApp()

  try {
    const current = h.live('approval', 'reused', 'runtime-A', { command: 'CURRENT_COMMAND' })
    await vi.waitFor(() => expect(h.text()).toContain('CURRENT_COMMAND'))
    h.live('secret', 'reused', 'foreign', { prompt: 'FOREIGN_SECRET' })
    h.cancel('foreign', 'reused')
    expect(getServerRequest('reused')).toBe(current)
    expect(getOverlayState().secret).toBeNull()
    const gate = h.hold('A')
    h.app().appActions.activateLiveSession('A')
    const call = await h.call('session.activate')
    h.reply(call, payload('runtime-A', [replay(promptCases[0], 'runtime-A')]))
    await flush()
    const newer = h.live('approval', 'newer', 'runtime-A', { command: 'LATER_COMMAND' })
    h.cancel('runtime-A', newer.id)
    gate.resolve()
    await flush()
    expect(getOverlayState().approval).toBeNull()
    expect(h.frames.some(f => f.id === 'reused')).toBe(false)
  } finally {
    h.close()
  }
})

it('fences a held clarify completion across adoption to a same-wire-ID replacement', async () => {
  const h = mountReplayApp()

  try {
    h.live('clarify', 'reused', 'runtime-A', promptCases[1].params)
    await vi.waitFor(() => expect(h.text()).toContain('REPLAY_QUESTION'))
    const lock = h.holdLock()
    h.stdin.write('\r')
    await vi.waitFor(() => expect(h.gateway.request.mock.calls.filter(([m]) => m === 'clarify.lock')).toHaveLength(1))
    h.app().appActions.activateLiveSession('B')
    h.reply(await h.call('session.activate'), payload('runtime-B', [replay(promptCases[1])]))
    await vi.waitFor(() => expect(getUiState().sid).toBe('runtime-B'))
    const current = getServerRequest('reused')
    lock.resolve({ status: 'ok', remaining: [] })
    await flush()
    expect(getServerRequest('reused')).toBe(current)
    expect(getOverlayState().clarify?.requestId).toBe('reused')
    expect(h.app().appTranscript.historyItems.some(m => m.role === 'user')).toBe(false)
  } finally {
    h.close()
  }
})

it('drops a held adoption on gateway exit and unmount without late source effects', async () => {
  const h = mountReplayApp()
  const gate = h.hold('B')
  h.app().appActions.activateLiveSession('B')
  h.reply(await h.call('session.activate'), payload('runtime-B', [replay(promptCases[0])]))
  await flush()
  h.gateway.emit('exit', 1)
  const sid = getUiState().sid
  gate.resolve()
  await flush()
  expect(getUiState().sid).toBe(sid)
  expect(getOverlayState().approval).toBeNull()
  h.close()
  const before = getOverlayState()
  h.live('approval', 'late', 'runtime-B', { command: 'LATE_COMMAND' })
  expect(getOverlayState()).toBe(before)
  expect(getServerRequest('late')).toBeUndefined()
})

it('a held create shares activation authority rather than adopting after a newer switch', async () => {
  const h = mountReplayApp()

  try {
    const gate = h.hold('create')
    const creating = h.app().appActions.newLiveSession()
    const createCall = await h.call('session.create')
    h.reply(createCall, payload('runtime-C', [replay(promptCases[0], 'runtime-C')]))
    await flush()
    h.app().appActions.activateLiveSession('B')
    h.reply(await h.call('session.activate'), payload('runtime-B', [replay(promptCases[0])]))
    await vi.waitFor(() => expect(getUiState().sid).toBe('runtime-B'))
    const current = getServerRequest('reused')
    gate.resolve()
    expect(await creating).toBeNull()
    expect(getServerRequest('reused')).toBe(current)
    expect(getUiState().sid).toBe('runtime-B')
  } finally {
    h.close()
  }
})

it.each(['superseded', 'setup-required'] as const)('fences the resume setup prerequisite when %s', async outcome => {
  const h = mountReplayApp()
  const setup = deferred<unknown>()

  try {
    h.setup(setup.promise)
    patchUiState({ busy: false })
    h.app().appActions.resumeById('cold')
    await vi.waitFor(() => expect(h.gateway.request).toHaveBeenCalledWith('setup.status', {}))

    if (outcome === 'superseded') {
      h.app().appActions.activateLiveSession('B')
      h.reply(await h.call('session.activate'), payload('runtime-B', [replay(promptCases[0])]))
      await vi.waitFor(() => expect(getUiState().sid).toBe('runtime-B'))
    }

    setup.resolve({ provider_configured: outcome !== 'setup-required' })
    await flush()
    expect(h.frames.some(f => f.method === 'session.resume')).toBe(false)
    expect(getUiState().sid).toBe(outcome === 'superseded' ? 'runtime-B' : 'runtime-A')
    expect($isBlocked.get()).toBe(outcome === 'superseded')
  } finally {
    setup.resolve(null)
    h.close()
  }
})

it('a late failure cannot publish errors or release the current adoption lease', async () => {
  const h = mountReplayApp()

  try {
    h.app().appActions.activateLiveSession('old')
    const old = await h.call('session.activate', 'old')
    h.app().appActions.activateLiveSession('new')
    const current = await h.call('session.activate', 'new')
    h.fail(old)
    await flush()
    expect($isBlocked.get()).toBe(true)
    expect(h.app().appTranscript.historyItems.some(m => m.text.includes('Synthetic failure'))).toBe(false)
    h.reply(current, payload('runtime-B', [replay(promptCases[0])]))
    await vi.waitFor(() => expect(h.text()).toContain('REPLAY_COMMAND'))
    h.stdin.write('\r')
    await vi.waitFor(() => expect(h.frames.filter(f => f.id === 'reused')).toHaveLength(1))
  } finally {
    h.close()
  }
})

it.each(promptCases.filter(test => !['approval', 'clarify'].includes(test.method)))(
  'same-SID $method adoption resets sensitive entry and local phase per actual instance',
  async test => {
    const h = mountReplayApp()

    try {
      const old = h.live(test.method, 'reused', 'runtime-A', test.params)
      await vi.waitFor(() => expect(h.text()).toContain(test.label))
      h.stdin.write('old-synthetic')
      await flush()

      if (test.key === 'vaultSaveLogin') {
        h.stdin.write('\r')
        await vi.waitFor(() => expect(h.text()).toContain('Password for old-synthetic'))
        h.stdin.write('old-password')
        await vi.waitFor(() => expect(h.text()).toContain('************'))
      }

      h.app().appActions.activateLiveSession('same-runtime-new-instance')
      const call = await h.call('session.activate')
      h.reply(call, payload('runtime-A', [replay(test, 'runtime-A')]))
      h.stdin.write('\x1b[13u')
      await vi.waitFor(() => expect(getServerRequest('reused')).not.toBe(old))
      await vi.waitFor(() => expect(h.text()).toContain(test.label))
      expect(h.text()).not.toContain('old-synthetic')
      expect(h.text()).not.toContain('************')
      expect(h.frames.some(f => f.id === 'reused')).toBe(false)

      // The new instance is shown in its first phase, not the old password phase.
      if (test.key === 'vaultSaveLogin') {
        expect(h.text()).not.toContain('Password for')
      }
    } finally {
      h.close()
    }
  }
)

it('adopts partial clarify answers without replaying a completed question', async () => {
  const h = mountReplayApp()

  try {
    const test: PromptCase = {
      ...promptCases[1],
      params: {
        questions: [
          { qid: 'done', question: 'DONE_QUESTION', choices: ['One'] },
          { qid: 'next', question: 'NEXT_QUESTION', choices: ['Two'] }
        ],
        answers: { done: 'One' }
      }
    }

    h.app().appActions.activateLiveSession('B')
    h.reply(await h.call('session.activate'), payload('runtime-B', [replay(test)]))
    await vi.waitFor(() => expect(h.text()).toContain('NEXT_QUESTION'))
    expect(getOverlayState().clarify?.answers).toEqual({ done: 'One' })
    h.stdin.write('\r')
    await vi.waitFor(() =>
      expect(h.gateway.request).toHaveBeenCalledWith('clarify.lock', {
        request_id: 'reused',
        question_id: 'next',
        answer: 'Two'
      })
    )
  } finally {
    h.close()
  }
})

it.each(['activate', 'resume'] as const)(
  '%s retains the complete collapsed-paste draft until fresh submission',
  async operation => {
    const h = mountReplayApp()

    try {
      await flush() // Finish fixture startup config before choosing the paste policy.
      patchUiState({ pasteCollapseChars: 10, busy: false })
      const full = 'SYNTHETIC_LONG_PASTED_DRAFT'
      h.stdin.write(`\x1b[200~${full}\x1b[201~`)
      await vi.waitFor(() => expect(h.app().appComposer.input).toContain('[['))
      const before = snapshot(h)

      if (operation === 'activate') {
        h.app().appActions.activateLiveSession('B')
      } else {
        h.app().appActions.resumeById('durable-B')
      }

      const call = await h.call(`session.${operation}`)
      h.reply(call, payload('runtime-B', [replay(promptCases[0])]))
      h.stdin.write('\r')
      await vi.waitFor(() => expect(h.text()).toContain('REPLAY_COMMAND'))
      expect(snapshot(h)).toEqual(before)
      expect(h.gateway.request.mock.calls.filter(([m]) => m === 'prompt.submit')).toHaveLength(0)
      h.stdin.write('\r')
      await vi.waitFor(() => expect(getOverlayState().approval).toBeNull())
      patchUiState({ busy: false })
      await vi.waitFor(() => expect(h.text()).toContain(before.input))
      h.stdin.write('\r')
      await vi.waitFor(() =>
        expect(h.gateway.request).toHaveBeenCalledWith('prompt.submit', { session_id: 'runtime-B', text: full })
      )
    } finally {
      h.close()
    }
  }
)
