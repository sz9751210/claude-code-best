import { describe, expect, test } from 'bun:test'
import { GeminiWebRunnerClient } from '../runnerClient.js'

describe('GeminiWebRunnerClient', () => {
  test('resolves response_complete for matching request id', async () => {
    const client = GeminiWebRunnerClient.createForTest()
    const resultPromise = client.awaitResponse('r1')
    client.injectLine(
      '{"type":"response_complete","request_id":"r1","text":"ok","timings":{"total_ms":1}}',
    )
    const result = await resultPromise
    expect(result.text).toBe('ok')
  })

  test('rejects on runner error event', async () => {
    const client = GeminiWebRunnerClient.createForTest()
    const resultPromise = client.awaitResponse('r2')
    client.injectLine(
      '{"type":"error","request_id":"r2","code":"response_timeout","message":"timeout","retryable":true}',
    )
    await expect(resultPromise).rejects.toThrow('response_timeout')
  })
})
