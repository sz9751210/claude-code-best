import { describe, expect, test } from 'bun:test'
import { isResponseStable } from '../completionDetector.js'

describe('isResponseStable', () => {
  test('returns false when text changed within stable window', () => {
    const stable = isResponseStable({
      generationActive: false,
      lastTextChangeAt: Date.now() - 1000,
      now: Date.now(),
      stableMs: 2000,
    })
    expect(stable).toBe(false)
  })

  test('returns true when generation ended and text stable >= window', () => {
    const stable = isResponseStable({
      generationActive: false,
      lastTextChangeAt: Date.now() - 2100,
      now: Date.now(),
      stableMs: 2000,
    })
    expect(stable).toBe(true)
  })

  test('returns false while generation is still active', () => {
    const stable = isResponseStable({
      generationActive: true,
      lastTextChangeAt: Date.now() - 5000,
      now: Date.now(),
      stableMs: 2000,
    })
    expect(stable).toBe(false)
  })
})
