import { describe, expect, test } from 'bun:test'
import { runGeminiWebTurn } from '../queryGeminiWeb.js'

describe('runGeminiWebTurn', () => {
  test('retries once for retryable failure', async () => {
    let calls = 0
    const result = await runGeminiWebTurn({
      prompt: 'hello',
      invoke: async () => {
        calls++
        if (calls === 1) {
          throw Object.assign(new Error('timeout'), { retryable: true })
        }
        return { text: 'ok' }
      },
    })

    expect(result.text).toBe('ok')
    expect(calls).toBe(2)
  })

  test('does not retry when error is not retryable', async () => {
    let calls = 0
    await expect(
      runGeminiWebTurn({
        prompt: 'hello',
        invoke: async () => {
          calls++
          throw new Error('fatal')
        },
      }),
    ).rejects.toThrow('fatal')
    expect(calls).toBe(1)
  })
})
