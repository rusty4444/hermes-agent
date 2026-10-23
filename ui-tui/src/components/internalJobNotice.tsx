import { Box, Text, useStdin } from '@hermes/ink'
import { stripAnsi } from '@hermes/shared/ansi'
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { $expandedJobNotices, toggleJobNotice } from '../app/internalJobNoticeStore.js'
import { $isBlocked } from '../app/overlayStore.js'
import { useT } from '../i18n/useT.js'
import type { Theme } from '../theme.js'
import type { Msg } from '../types.js'

export function InternalJobNotice({ msg, t }: { msg: Msg; t: Theme }) {
  const expanded = useStore($expandedJobNotices)
  const blocked = useStore($isBlocked)
  const [focused, setFocused] = useState(false)
  const button = useRef<FocusNode | null>(null)
  const { inputEmitter } = useStdin()
  const T = useT().chatBits.messageLine
  const notice = msg.jobNotice!
  const open = expanded.has(notice.id)

  useEffect(() => {
    if (!focused || !inputEmitter) {
      return
    }

    // Ink's legacy useInput listeners run *before* DOM keydown. Claim button
    // keys before the composer can submit a draft or insert a space. Modal
    // decisions always take priority over this nonblocking transcript control.
    const handle: Parameters<typeof inputEmitter.on>[1] = event => {
      if (
        $isBlocked.get() ||
        event.keypress.isPasted ||
        event.keypress.ctrl ||
        event.keypress.meta ||
        event.keypress.super
      ) {
        return
      }

      if (event.key.escape) {
        event.stopImmediatePropagation()
        let root = button.current

        while (root?.parentNode) {
          root = root.parentNode
        }

        root?.focusManager?.blur()
      } else if (event.key.return || event.input === ' ') {
        event.stopImmediatePropagation()
        toggleJobNotice(notice.id)
      }
    }

    inputEmitter.prependListener('input', handle)

    return () => {
      inputEmitter.removeListener('input', handle)
    }
  }, [focused, inputEmitter, notice.id])

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={t.color.muted} wrap="truncate-end">
        ◈ {notice.hasIssues ? `${T.jobIssues} · ` : ''}
        {T.internalJob} · {msg.text}
      </Text>
      <Box
        alignSelf="flex-start"
        onBlur={() => setFocused(false)}
        onClick={(event: { stopImmediatePropagation: () => void }) => {
          event.stopImmediatePropagation()

          if (!blocked) {
            toggleJobNotice(notice.id)
          }
        }}
        onFocus={() => setFocused(true)}
        ref={(node: FocusNode | null) => {
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

interface FocusNode {
  parentNode?: FocusNode
  focusManager?: { blur: () => void }
}
