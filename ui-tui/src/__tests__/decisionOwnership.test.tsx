import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { AlternateScreen, Box, renderSync } from '@hermes/ink'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
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
import { $isBlocked, getOverlayState, patchOverlayState, resetOverlayState } from '../app/overlayStore.js'
import { hasOpenServerRequest, resetServerRequestsForTests } from '../app/serverRequestStore.js'
import { turnController } from '../app/turnController.js'
import { patchUiState, resetUiState } from '../app/uiStore.js'
import { useMainApp } from '../app/useMainApp.js'
import { PromptZone } from '../components/appOverlays.js'
import { TextInput } from '../components/textInput.js'

beforeEach(() => {
  resetUiState()
  resetOverlayState()
  turnController.fullReset()
  resetServerRequestsForTests()
  patchUiState({ sid: 'session-A', busy: true })
})
afterEach(() => {
  turnController.fullReset()
  resetOverlayState()
  resetServerRequestsForTests()
})

// Only transport and unrelated OS calls are fixtures. Decisions, submission,
// stores, focus, keyboard parser and the native screen are production code.
function mountApp() {
  const gateway = Object.assign(new EventEmitter(), {
    request: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => null),
    drain: vi.fn(),
    start: vi.fn(),
    kill: vi.fn(),
    notify: vi.fn(),
    getLogTail: () => []
  })

  let app: ReturnType<typeof useMainApp>

  function Tree() {
    app = useMainApp(gateway as never)
    const blocked = useStore($isBlocked)
    const actions = app.appActions

    return (
      <AlternateScreen>
        <Box flexDirection="column" height={40}>
          <PromptZone
            cols={100}
            onApprovalChoice={actions.answerApproval}
            onClarifyCancel={actions.cancelClarify}
            onClarifyQuestionAnswer={actions.answerClarifyQuestion}
            onSecretSubmit={actions.answerSecret}
            onSudoSubmit={actions.answerSudo}
            onVaultCodeSubmit={actions.answerVaultCode}
            onVaultSaveLoginSubmit={actions.answerVaultSaveLogin}
            onVaultUnlockSubmit={actions.answerVaultUnlock}
          />
          {!blocked && (
            <TextInput
              onChange={app.appComposer.updateInput}
              onSubmit={app.appComposer.submit}
              value={app.appComposer.input}
            />
          )}
        </Box>
      </AlternateScreen>
    )
  }

  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
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
    const screen: Screen = (ink as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen

    return Array.from({ length: screen.height }, (_, y) =>
      Array.from({ length: screen.width }, (_, x) => cellAtIndex(screen, y * screen.width + x).char).join('')
    ).join('\n')
  }

  const request = (method: string, id: string, params = {}) => {
    const req = {
      id,
      method,
      params: { session_id: 'session-A', ...params },
      respond: vi.fn(),
      fail: vi.fn()
    } satisfies ServerRequest

    gateway.emit('request', req)

    return req
  }

  const approval = (id: string, command: string) => request('approval', id, { command, description: 'Review' })

  const clarify = (id: string) =>
    request('clarify', id, { questions: [{ qid: 'question', question: `Question ${id}`, choices: ['One', 'Two'] }] })

  return {
    gateway,
    stdin,
    text,
    app: () => app,
    approval,
    clarify,
    request,
    close: () => {
      view.unmount()
      view.cleanup()
    }
  }
}

it.each(['next-id', 'same-id'])(
  'rejects a stale visible approval before %s replacement paints, then accepts a fresh gesture',
  async id => {
    const h = mountApp()

    try {
      h.app().appComposer.updateInput('draft')
      await vi.waitFor(() => expect(h.text()).toContain('draft'))
      const old = h.approval('same-id', 'OLD_COMMAND')
      await vi.waitFor(() => expect(h.text()).toContain('OLD_COMMAND'))
      const next = h.approval(id, 'NEXT_COMMAND')
      h.stdin.write('\r') // no React paint/effect wait
      await vi.waitFor(() => expect(h.text()).toContain('NEXT_COMMAND'))
      expect(old.respond).not.toHaveBeenCalled()
      expect(next.respond).not.toHaveBeenCalled()
      expect(hasOpenServerRequest(id)).toBe(true)
      expect(h.app().appComposer.input).toBe('draft')
      h.stdin.write('1')
      await vi.waitFor(() => expect(next.respond).toHaveBeenCalledExactlyOnceWith({ choice: 'once' }))
      expect(old.respond).not.toHaveBeenCalled()
    } finally {
      h.close()
    }
  }
)

it('does not clear a reentrant same-ID request during synchronous response cleanup', async () => {
  const h = mountApp()

  try {
    const old = h.approval('reused', 'OLD_COMMAND')
    await vi.waitFor(() => expect(h.text()).toContain('OLD_COMMAND'))
    let next: ReturnType<typeof h.approval> | undefined
    old.respond.mockImplementation(() => {
      next = h.approval('reused', 'NEXT_COMMAND')
    })
    h.stdin.write('\r')
    await vi.waitFor(() => expect(old.respond).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(h.text()).toContain('NEXT_COMMAND'))
    expect(getOverlayState().approval?.requestId).toBe('reused')
    expect(hasOpenServerRequest('reused')).toBe(true)
    expect(next!.respond).not.toHaveBeenCalled()
    h.stdin.write('\r')
    await vi.waitFor(() => expect(next!.respond).toHaveBeenCalledOnce())
  } finally {
    h.close()
  }
})

it('suppresses Ctrl+C aimed at an obsolete visible approval', async () => {
  const h = mountApp()

  try {
    const old = h.approval('old', 'OLD_COMMAND')
    await vi.waitFor(() => expect(h.text()).toContain('OLD_COMMAND'))
    const next = h.approval('next', 'NEXT_COMMAND')
    h.stdin.write('\u0003')
    await vi.waitFor(() => expect(h.text()).toContain('NEXT_COMMAND'))
    expect(old.respond).not.toHaveBeenCalled()
    expect(next.respond).not.toHaveBeenCalled()
    h.stdin.write('\u0003')
    await vi.waitFor(() => expect(next.respond).toHaveBeenCalledExactlyOnceWith({ choice: 'deny' }))
  } finally {
    h.close()
  }
})

it.each(['clarify', 'sudo'] as const)('keeps replaced %s usable without admitting the stale Return', async kind => {
  const h = mountApp()

  try {
    const old = kind === 'clarify' ? h.clarify('old') : h.request('sudo', 'old')
    await vi.waitFor(() => expect(h.text()).toContain(kind === 'clarify' ? 'Question old' : 'password'))

    if (kind === 'sudo') {
      h.stdin.write('fixture')
      await vi.waitFor(() => expect(h.text()).toContain('*******'))
    }

    const next = kind === 'clarify' ? h.clarify('next') : h.request('sudo', 'next')
    h.stdin.write('\r')
    await vi.waitFor(() => expect(getOverlayState()[kind]?.requestId).toBe('next'))
    await vi.waitFor(() => expect(h.text()).toContain(kind === 'clarify' ? 'Question next' : 'password'))

    if (kind === 'sudo') {
      await vi.waitFor(() => expect(h.text()).not.toContain('*******'))
    }

    expect(old.respond).not.toHaveBeenCalled()
    expect(next.respond).not.toHaveBeenCalled()
    expect(h.gateway.request.mock.calls.filter(([method]) => method === 'clarify.lock')).toHaveLength(0)

    if (kind === 'clarify') {
      h.gateway.request.mockResolvedValue({ status: 'ok', remaining: [] })
    }

    h.stdin.write('\r')

    if (kind === 'sudo') {
      await vi.waitFor(() => expect(next.respond).toHaveBeenCalledExactlyOnceWith({ value: '' }))
    } else {
      await vi.waitFor(() =>
        expect(h.gateway.request).toHaveBeenCalledWith('clarify.lock', {
          answer: 'One',
          question_id: 'question',
          request_id: 'next'
        })
      )
    }
  } finally {
    h.close()
  }
})

it('retains a failed synchronous response for a fresh retry', async () => {
  const h = mountApp()

  try {
    const req = h.approval('retry', 'RETRY_COMMAND')
    req.respond.mockImplementationOnce(() => {
      throw new Error('Fixture transport failure')
    })
    await vi.waitFor(() => expect(h.text()).toContain('RETRY_COMMAND'))
    h.app().appActions.answerApproval('once')
    expect(hasOpenServerRequest('retry')).toBe(true)
    expect(getOverlayState().approval?.requestId).toBe('retry')
    h.app().appActions.answerApproval('once')
    expect(req.respond).toHaveBeenCalledTimes(2)
    expect(hasOpenServerRequest('retry')).toBe(false)
    expect(getOverlayState().approval).toBeNull()
  } finally {
    h.close()
  }
})

it.each(['approval', 'clarify', 'sudo'] as const)(
  'rejects retained %s callbacks after a session change',
  async kind => {
    const h = mountApp()

    try {
      const req =
        kind === 'approval'
          ? h.approval('old', 'OLD_COMMAND')
          : kind === 'clarify'
            ? h.clarify('old')
            : h.request('sudo', 'old')

      await vi.waitFor(() => expect(getOverlayState()[kind]).not.toBeNull())
      await vi.waitFor(() =>
        expect(h.text()).toContain(
          kind === 'approval' ? 'OLD_COMMAND' : kind === 'clarify' ? 'Question old' : 'password'
        )
      )
      const actions = h.app().appActions
      patchUiState({ sid: 'session-B' })

      if (kind === 'approval') {
        actions.answerApproval('once')
      } else if (kind === 'clarify') {
        actions.answerClarifyQuestion('question', 'One')
      } else {
        actions.answerSudo('fixture-not-a-credential')
      }

      expect(req.respond).not.toHaveBeenCalled()
      expect(h.gateway.request.mock.calls.filter(([method]) => method === 'clarify.lock')).toHaveLength(0)
      expect(hasOpenServerRequest('old')).toBe(true)
    } finally {
      h.close()
    }
  }
)

it.each(['success', 'expired', 'rejection'] as const)(
  'fences a held clarify %s completion from its replacement',
  async outcome => {
    const h = mountApp()
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void

    try {
      h.gateway.request.mockImplementation(async method =>
        method === 'clarify.lock'
          ? new Promise((res, rej) => {
              resolve = res
              reject = rej
            })
          : null
      )
      h.clarify('old')
      await vi.waitFor(() => expect(h.text()).toContain('Question old'))
      h.stdin.write('\r')
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
      h.clarify('next')

      if (outcome === 'rejection') {
        reject(new Error('Fixture transport failure'))
      } else {
        resolve({ status: outcome === 'expired' ? 'expired' : 'ok', remaining: [] })
      }

      await vi.waitFor(() => expect(h.text()).toContain('Question next'))
      await new Promise<void>(done => setImmediate(done))
      expect(getOverlayState().clarify?.requestId).toBe('next')
      expect(hasOpenServerRequest('next')).toBe(true)
    } finally {
      h.close()
    }
  }
)

it('uses PromptZone priority: a hidden clarify is not eligible beneath approval', async () => {
  const h = mountApp()

  try {
    h.clarify('hidden')
    await vi.waitFor(() => expect(h.text()).toContain('Question hidden'))
    const answer = h.app().appActions.answerClarifyQuestion
    h.approval('visible', 'VISIBLE_COMMAND')
    answer('question', 'One')
    expect(h.gateway.request.mock.calls.filter(([method]) => method === 'clarify.lock')).toHaveLength(0)
    await vi.waitFor(() => expect(h.text()).toContain('VISIBLE_COMMAND'))
  } finally {
    h.close()
  }
})

it('suppresses cleared prompt callbacks without hiding another kind', async () => {
  const h = mountApp()

  try {
    const old = h.approval('old', 'OLD_COMMAND')
    await vi.waitFor(() => expect(h.text()).toContain('OLD_COMMAND'))
    const answer = h.app().appActions.answerApproval
    patchOverlayState({ approval: null })
    h.clarify('next')
    answer('once')
    expect(old.respond).not.toHaveBeenCalled()
    expect(getOverlayState().clarify?.requestId).toBe('next')
  } finally {
    h.close()
  }
})
