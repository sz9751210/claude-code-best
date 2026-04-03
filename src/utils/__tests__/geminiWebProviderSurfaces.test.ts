import { describe, expect, test } from 'bun:test'
import { isAnalyticsDisabled } from 'src/services/analytics/config.js'
import { isProviderManagedEnvVar } from '../managedEnvConstants.js'

describe('geminiWeb provider surfaces', () => {
  test('provider-managed env includes CLAUDE_CODE_USE_GEMINI_WEB', () => {
    expect(isProviderManagedEnvVar('CLAUDE_CODE_USE_GEMINI_WEB')).toBe(true)
  })

  test('analytics disabled when CLAUDE_CODE_USE_GEMINI_WEB is set', () => {
    const previous = process.env.CLAUDE_CODE_USE_GEMINI_WEB
    process.env.CLAUDE_CODE_USE_GEMINI_WEB = '1'
    try {
      expect(isAnalyticsDisabled()).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_USE_GEMINI_WEB
      } else {
        process.env.CLAUDE_CODE_USE_GEMINI_WEB = previous
      }
    }
  })
})
