import { createHash } from 'node:crypto'

import { LONG_MSG } from '../config/limits.js'
import { t } from '../i18n/runtime.js'
import { buildToolTrailLine } from '../lib/text.js'
import type { Msg, SessionInfo } from '../types.js'

export const introMsg = (info: SessionInfo): Msg => ({ info, kind: 'intro', role: 'system', text: '' })

export const userDisplay = (text: string) => {
  if (text.length <= LONG_MSG) {
    return text
  }

  const first = text.split('\n')[0]?.trim() ?? ''
  const words = first.split(/\s+/).filter(Boolean)
  const prefix = (words.length > 1 ? words.slice(0, 4).join(' ') : first).slice(0, 80)

  return t('libText.messages.longMessage', prefix || t('libText.messages.messageFallback'))
}

export const isInternalJobNoticeKind = (kind: unknown): boolean =>
  kind === 'async_delegation_complete' || kind === 'process_complete'

export const toTranscriptMessages = (rows: unknown, conversationId?: null | string): Msg[] => {
  if (!Array.isArray(rows)) {
    return []
  }

  const out: Msg[] = []
  const occurrences = new Map<string, number>()
  let pending: string[] = []

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }

    const { context, display_kind, name, role, text, timestamp } = row as TranscriptRow

    const createdAt =
      typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined

    if (role === 'tool') {
      pending.push(buildToolTrailLine(name ?? 'tool', context ?? ''))

      continue
    }

    if (typeof text !== 'string' || !text.trim()) {
      continue
    }

    // Display-only timeline events: render as dim ◈ markers instead of
    // opaque user messages. Hidden compaction handoffs are skipped entirely.
    if (display_kind === 'hidden') {
      continue
    }

    if (display_kind === 'model_switch') {
      out.push({ kind: 'event', role: 'system', text: t('libText.messages.modelChanged') })
      pending = []

      continue
    }

    if (display_kind === 'auto_continue') {
      out.push({ kind: 'event', role: 'system', text: t('libText.messages.resumedInterruptedTurn') })
      pending = []

      continue
    }

    if (display_kind === 'personality_switch') {
      out.push({ kind: 'event', role: 'system', text: t('libText.messages.personalityChanged') })
      pending = []

      continue
    }

    if (isInternalJobNoticeKind(display_kind)) {
      const meta = (row as TranscriptRow).display_metadata
      const count = meta && typeof meta.task_count === 'number' ? meta.task_count : undefined
      const backendId = typeof meta?.notice_id === 'string' ? meta.notice_id : undefined
      const recordId = (row as TranscriptRow).row_id
      const hasRecordId = typeof recordId === 'string' || typeof recordId === 'number'
      const authored = hasRecordId ? ['row', recordId] : createdAt !== undefined ? ['time', createdAt] : null
      const fallback = JSON.stringify([conversationId ?? null, display_kind, authored, hasRecordId ? null : text])
      const occurrence = occurrences.get(fallback) ?? 0
      occurrences.set(fallback, occurrence + 1)

      const id =
        backendId ??
        createHash('sha256')
          .update(JSON.stringify([fallback, hasRecordId ? 0 : occurrence]))
          .digest('hex')

      const label =
        display_kind === 'process_complete'
          ? t('libText.messages.backgroundProcessFinished')
          : count === undefined
            ? t('libText.messages.backgroundAgentWorkFinished')
            : t(
                count === 1
                  ? 'libText.messages.backgroundAgentsFinishedOne'
                  : 'libText.messages.backgroundAgentsFinishedOther',
                count
              )

      out.push({
        kind: 'event',
        role: 'system',
        text: typeof meta?.display_text === 'string' ? meta.display_text : label,
        ...(createdAt !== undefined && { createdAt }),
        jobNotice: {
          // Opaque producer IDs stay intact; presentation keys qualify ownership.
          id,
          ...(conversationId ? { key: JSON.stringify([conversationId, display_kind, id]) } : {}),
          ...(meta ? { metadata: meta } : {}),
          // Equal unidentified arrivals are not proof of replay. Occurrence keys
          // preserve snapshot multiplicity, but indistinguishable legacy pages
          // cannot promise perfect identity without producer information.
          ...(backendId === undefined && authored === null ? { replayable: false } : {}),
          body: text,
          hasIssues: meta?.has_issues === true || (typeof meta?.failed_count === 'number' && meta.failed_count > 0)
        }
      })
      pending = []

      continue
    }

    if (role === 'assistant') {
      out.push({ role, text, ...(createdAt !== undefined && { createdAt }), ...(pending.length && { tools: pending }) })
      pending = []
    } else if (role === 'user' || role === 'system') {
      out.push({ role, text, ...(createdAt !== undefined && { createdAt }) })
      pending = []
    }
  }

  return dedupeJobNotices(out)
}

// Resume can include the same row in both history and the in-flight snapshot.
// Replayed start events must not add a second card (or alter human messages).
export const dedupeJobNotices = (items: Msg[]): Msg[] => {
  const seen = new Set<string>()

  return items.flatMap(msg => {
    if (!msg.jobNotice) {
      return [msg]
    }

    const key = jobNoticeKey(msg.jobNotice)

    if (msg.jobNotice.replayable === false) {
      // Preserve separate unidentifiable arrivals, including their independent
      // expansion controls. This local occurrence cannot identify an unseen
      // legacy page/replay with no authoring fields; never drop its report.
      let unique = key
      let occurrence = 0

      while (seen.has(unique)) {
        unique = JSON.stringify([key, 'occurrence', ++occurrence])
      }

      seen.add(unique)

      return [unique === key ? msg : { ...msg, jobNotice: { ...msg.jobNotice, key: unique } }]
    }

    if (seen.has(key)) {
      return []
    }

    seen.add(key)

    return [msg]
  })
}

export const jobNoticeKey = (notice: NonNullable<Msg['jobNotice']>): string => notice.key ?? notice.id

export const fmtDuration = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60

  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

interface TranscriptRow {
  row_id?: number | string
  context?: string
  display_kind?: string
  display_metadata?: { task_count?: number; [key: string]: unknown }
  name?: string
  role?: string
  text?: string
  timestamp?: number
}
