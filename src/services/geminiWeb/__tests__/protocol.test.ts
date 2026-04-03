import { describe, expect, test } from 'bun:test'
import { decodeProtocolLine, encodeProtocolMessage } from '../protocol.js'

describe('gemini web protocol', () => {
  test('encodes a message as a single NDJSON line', () => {
    const line = encodeProtocolMessage({ type: 'init', request_id: 'r1' })
    expect(line.endsWith('\n')).toBe(true)
  })

  test('decodes valid line into typed object', () => {
    const msg = decodeProtocolLine(
      '{"type":"error","request_id":"r1","code":"response_timeout","message":"timeout","retryable":true}',
    )
    expect(msg.type).toBe('error')
  })

  test('throws for invalid JSON', () => {
    expect(() => decodeProtocolLine('not-json')).toThrow()
  })
})
