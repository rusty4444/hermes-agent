import { MAX_HISTORY } from '../config/limits.js'
import { dedupeJobNotices, jobNoticeKey } from '../domain/messages.js'
import type { Msg, Role } from '../types.js'

import { appendToolShelfMessage } from './liveProgress.js'

// Stamp live rows AT APPEND (wall clock, Unix seconds) rather than later:
// a message's authoring time is when it entered the transcript, not when it
// happened to be persisted or re-rendered (#82840-class rule). Rehydrated
// rows arrive with their persisted `createdAt` and keep it.
export const appendTranscriptMessage = (prev: Msg[], msg: Msg): Msg[] => {
  if (
    msg.jobNotice &&
    msg.jobNotice.replayable !== false &&
    prev.some(item => item.jobNotice && jobNoticeKey(item.jobNotice) === jobNoticeKey(msg.jobNotice!))
  ) {
    return prev
  }

  const next = appendToolShelfMessage(
    prev,
    msg.createdAt === undefined ? { ...msg, createdAt: Date.now() / 1000 } : msg
  )

  return msg.jobNotice?.replayable === false ? dedupeJobNotices(next) : next
}

export const capTranscriptHistory = (items: Msg[]): Msg[] => {
  items = dedupeJobNotices(items)

  if (items.length <= MAX_HISTORY) {
    return items
  }

  return items[0]?.kind === 'intro' ? [items[0], ...items.slice(-(MAX_HISTORY - 1))] : items.slice(-MAX_HISTORY)
}

export const upsert = (prev: Msg[], role: Role, text: string): Msg[] =>
  prev.at(-1)?.role === role ? [...prev.slice(0, -1), { role, text }] : [...prev, { role, text }]
