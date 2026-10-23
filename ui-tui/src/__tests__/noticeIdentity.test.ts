import { describe, expect, it } from 'vitest'

import { toTranscriptMessages } from '../domain/messages.js'
import { appendTranscriptMessage, capTranscriptHistory } from '../lib/messages.js'

const body = 'Exact backend report\nREPORT_END'

const row = (kind = 'process_complete', extra = {}) => ({
  display_kind: kind,
  role: 'user',
  text: body,
  ...extra
})

// These are trusted envelopes, never classifications inferred from report text.
describe('notice presentation identity', () => {
  it('qualifies opaque IDs by conversation and kind while preserving raw metadata', () => {
    const metadata = { notice_id: 'same-id', untouched: { value: 'raw' } }
    const [a] = toTranscriptMessages([row(undefined, { display_metadata: metadata })], 'A')
    const [b] = toTranscriptMessages([row(undefined, { display_metadata: metadata })], 'B')
    const [otherKind] = toTranscriptMessages([row('async_delegation_complete', { display_metadata: metadata })], 'A')
    expect(a?.jobNotice?.id).toBe('same-id')
    expect(a?.jobNotice?.key).not.toBe(b?.jobNotice?.key)
    expect(a?.jobNotice?.key).not.toBe(otherKind?.jobNotice?.key)
    expect(a?.jobNotice?.metadata).toBe(metadata)
    expect(capTranscriptHistory([a!, b!, otherKind!])).toHaveLength(3)
  })

  it('keeps identified row keys stable across rehydration and prepended pages', () => {
    const record = row(undefined, { row_id: 21, timestamp: 2 })
    const original = toTranscriptMessages([record], 'A')[0]!
    const paged = toTranscriptMessages([row(undefined, { row_id: 20 }), { ...record }], 'A')[1]!
    expect(paged.jobNotice?.key).toBe(original.jobNotice?.key)
    expect(capTranscriptHistory([original, paged])).toHaveLength(1)
    expect(toTranscriptMessages([record, { ...record }], 'A')).toHaveLength(1)
  })

  it('does not discard equal-body completions of different trusted kinds', () => {
    const [delegation] = toTranscriptMessages([row('async_delegation_complete')])
    const [process] = toTranscriptMessages([row()])
    expect(appendTranscriptMessage([delegation!], process!)).toHaveLength(2)
    expect(capTranscriptHistory([delegation!, process!])).toHaveLength(2)
  })

  it('preserves separate persisted authoring times and durable row identities', () => {
    for (const records of [
      [row(undefined, { timestamp: 1 }), row(undefined, { timestamp: 2 })],
      [row(undefined, { row_id: 10 }), row(undefined, { row_id: 11 })],
      [row(undefined, { timestamp: 1 }), row(undefined, { timestamp: 1 })],
      [row(), row()]
    ]) {
      const items = toTranscriptMessages(records)
      expect(items).toHaveLength(2)
      expect(items[0]?.jobNotice?.id).not.toBe(items[1]?.jobNotice?.id)
      expect(capTranscriptHistory(items)).toHaveLength(2)
      expect(items.map(msg => msg.jobNotice?.body)).toEqual([body, body])
    }
  })

  it('does not mistake separate unidentifiable arrivals for a replay', () => {
    const [first] = toTranscriptMessages([row()])
    const [second] = toTranscriptMessages([row()])
    const items = appendTranscriptMessage([first!], second!)
    expect(items).toHaveLength(2)
    expect(items[0]!.jobNotice!.key ?? items[0]!.jobNotice!.id).not.toBe(
      items[1]!.jobNotice!.key ?? items[1]!.jobNotice!.id
    )
    expect(capTranscriptHistory(items)).toEqual(items)
  })

  it('keeps opaque backend IDs unchanged and deduplicates actual replay', () => {
    const metadata = { notice_id: '  opaque:/ID\u0000  ', nested: { token: 'Unchanged' } }
    const items = toTranscriptMessages([row(undefined, { display_metadata: metadata })])
    expect(items[0]?.jobNotice?.id).toBe(metadata.notice_id)
    expect(appendTranscriptMessage(items, items[0]!)).toHaveLength(1)
    expect(capTranscriptHistory([...items, ...items])).toHaveLength(1)
    expect(metadata).toEqual({ notice_id: '  opaque:/ID\u0000  ', nested: { token: 'Unchanged' } })
  })

  it('never promotes a human quotation or an unknown typed kind', () => {
    const items = toTranscriptMessages([
      { role: 'user', text: '[ASYNC DELEGATION COMPLETE]\n' + body },
      row('unrecognized_completion')
    ])

    expect(items.map(msg => msg.role)).toEqual(['user', 'user'])
    expect(items.every(msg => !msg.jobNotice)).toBe(true)
  })
})
