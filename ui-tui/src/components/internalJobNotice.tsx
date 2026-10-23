import { Box, type DOMElement, getFocusManager, type KeyboardEvent, Text } from '@hermes/ink'
import { stripAnsi } from '@hermes/shared/ansi'
import { useStore } from '@nanostores/react'
import { useRef, useState } from 'react'

import { $expandedJobNotices, toggleJobNotice } from '../app/internalJobNoticeStore.js'
import { $isBlocked } from '../app/overlayStore.js'
import { jobNoticeKey } from '../domain/messages.js'
import { useT } from '../i18n/useT.js'
import type { Theme } from '../theme.js'
import type { Msg } from '../types.js'

export function InternalJobNotice({ msg, t }: { msg: Msg; t: Theme }) {
  const expanded = useStore($expandedJobNotices)
  const blocked = useStore($isBlocked)
  const [focused, setFocused] = useState(false)
  const button = useRef<DOMElement | null>(null)
  const T = useT().chatBits.messageLine
  const notice = msg.jobNotice!
  const identity = jobNoticeKey(notice)
  const open = expanded.has(identity)

  const handleKeyDown = (event: KeyboardEvent) => {
    // Decision overlays retain priority even before React re-renders this
    // control. Native dispatch, not focused React state, chooses the owner.
    if ($isBlocked.get() || event.isPasted || event.ctrl || event.meta || event.superKey || event.fn) {
      return
    }

    if (event.key === 'tab') {
      // Keep native Tab cycling but do not run composer completion / YOLO.
      event.stopImmediatePropagation()
    } else if (!event.shift && event.key === 'escape') {
      event.preventDefault()
      getFocusManager(button.current!).blur()
    } else if (!event.shift && (event.key === 'return' || event.key === ' ')) {
      event.preventDefault()
      toggleJobNotice(identity)
    }
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={t.color.muted} wrap="truncate-end">
        ◈ {notice.hasIssues ? `${T.jobIssues} · ` : ''}
        {T.internalJob} · {stripAnsi(msg.text)}
      </Text>
      <Box
        alignSelf="flex-start"
        onBlur={() => setFocused(false)}
        onClick={(event: { stopImmediatePropagation: () => void }) => {
          event.stopImmediatePropagation()

          if (!$isBlocked.get()) {
            toggleJobNotice(identity)
          }
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={handleKeyDown}
        ref={(node: DOMElement | null) => {
          button.current = node
        }}
        tabIndex={blocked ? -1 : 0}
      >
        <Text bold={focused && !blocked} color={t.color.muted} underline={focused && !blocked}>
          {open ? '▾ ' : '▸ '}
          {open ? T.collapseJob : T.expandJob}
          {focused && !blocked ? ` · ${T.jobKeyboardHint}` : ''}
        </Text>
      </Box>
      {open && <Text color={t.color.muted}>{stripAnsi(notice.body)}</Text>}
    </Box>
  )
}
