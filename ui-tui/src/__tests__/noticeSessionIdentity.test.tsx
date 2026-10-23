import { PassThrough } from 'node:stream'

import { AlternateScreen, Box, renderSync } from '@hermes/ink'
import React, { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@hermes/ink', async () => import('../../packages/hermes-ink/src/entry-exports.js'))

import instances from '../../packages/hermes-ink/src/ink/instances.js'
import { cellAtIndex, type Screen } from '../../packages/hermes-ink/src/ink/screen.js'
import { $expandedJobNotices } from '../app/internalJobNoticeStore.js'
import { resetOverlayState } from '../app/overlayStore.js'
import { turnController } from '../app/turnController.js'
import { resetUiState } from '../app/uiStore.js'
import { useSessionLifecycle } from '../app/useSessionLifecycle.js'
import { MessageLine } from '../components/messageLine.js'
import { TextInput } from '../components/textInput.js'
import { DEFAULT_THEME } from '../theme.js'
import type { Msg } from '../types.js'

beforeEach(() => {
  resetUiState()
  resetOverlayState()
  turnController.fullReset()
  $expandedJobNotices.set(new Set())
})
afterEach(() => {
  turnController.fullReset()
  resetOverlayState()
})

it.each(['async_delegation_complete', 'process_complete'])(
  '%s isolates activation expansion and restores A after B',
  async display_kind => {
    let session!: ReturnType<typeof useSessionLifecycle>

    function Tree() {
      const [items, setHistoryItems] = useState<Msg[]>([])
      session = useSessionLifecycle({
        colsRef: { current: 100 },
        composerActions: { setComposerTokens: vi.fn() },
        gw: {
          request: async (_method: string, params: { session_id: string }) => ({
            session_id: params.session_id,
            session_key: `durable-${params.session_id}`,
            running: false,
            messages: [
              {
                role: 'user',
                text: 'Same private report\nEND_OF_PRIVATE_REPORT',
                display_kind,
                timestamp: 1,
                display_metadata: { display_text: `Completion ${params.session_id}` }
              }
            ]
          })
        },
        rpc: vi.fn(async () => ({})),
        panel: vi.fn(),
        scrollRef: { current: null },
        setHistoryItems,
        setLastUserMsg: vi.fn(),
        setSessionStartedAt: vi.fn(),
        setStickyPrompt: vi.fn(),
        setVoiceProcessing: vi.fn(),
        setVoiceRecording: vi.fn(),
        sys: vi.fn()
      } as never)

      return (
        <AlternateScreen>
          <Box flexDirection="column" height={40}>
            {items.map((msg, index) => (
              <MessageLine cols={100} key={index} msg={msg} t={DEFAULT_THEME} />
            ))}
            <TextInput onChange={() => {}} onSubmit={() => {}} value="draft" />
          </Box>
        </AlternateScreen>
      )
    }

    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
    stdout.on('data', () => {})

    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
      ref: () => {},
      unref: () => {}
    })

    const view = renderSync(<Tree />, {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: new PassThrough() as never,
      patchConsole: false
    })

    const ink = instances.get(stdout as never)!
    ink.setAltScreenActive(true)

    const text = () => {
      const screen: Screen = (ink as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen

      return Array.from({ length: screen.height }, (_, y) =>
        Array.from({ length: screen.width }, (_, x) => cellAtIndex(screen, y * screen.width + x).char).join('')
      ).join('\n')
    }

    try {
      session.activateLiveSession('A')
      await vi.waitFor(() => expect(text()).toContain('Completion A'))
      stdin.write('\t\r') // one native read, without a paint between keys
      await vi.waitFor(() => expect(text()).toContain('END_OF_PRIVATE_REPORT'))
      session.activateLiveSession('B')
      await vi.waitFor(() => expect(text()).toContain('Completion B'))
      expect(text()).toContain('Expand details')
      expect(text()).not.toContain('END_OF_PRIVATE_REPORT')
      session.activateLiveSession('A')
      await vi.waitFor(() => expect(text()).toContain('Completion A'))
      expect(text()).toContain('Collapse details')
      expect(text()).toContain('END_OF_PRIVATE_REPORT')
    } finally {
      view.unmount()
      view.cleanup()
    }
  }
)
