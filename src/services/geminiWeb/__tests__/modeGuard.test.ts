import { describe, expect, test } from 'bun:test'
import { assertGeminiWebModeSupported } from '../modeGuard.js'

describe('assertGeminiWebModeSupported', () => {
  test('does not throw in interactive mode', () => {
    expect(() =>
      assertGeminiWebModeSupported({
        apiProvider: 'geminiWeb',
        isNonInteractiveSession: false,
      }),
    ).not.toThrow()
  })

  test('does not throw in print mode', () => {
    expect(() =>
      assertGeminiWebModeSupported({
        apiProvider: 'geminiWeb',
        isNonInteractiveSession: true,
      }),
    ).not.toThrow()
  })

  test('does not throw for other providers', () => {
    expect(() =>
      assertGeminiWebModeSupported({
        apiProvider: 'firstParty',
        isNonInteractiveSession: false,
      }),
    ).not.toThrow()
  })
})
