import { describe, expect, test } from 'bun:test'
import { Readable, Writable } from 'stream'
import {
  decodeProtocolLine,
  encodeProtocolMessage,
  type GeminiRunnerEvent,
} from '../protocol.js'
import {
  runGeminiWebRunnerWithIO,
  type GeminiWebRunnerDomDriver,
} from '../runner.js'

function createOutputCapture(): {
  stream: Writable
  read: () => string
} {
  let output = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString()
      callback()
    },
  })
  return {
    stream,
    read: () => output,
  }
}

describe('runGeminiWebRunnerWithIO', () => {
  test('processes init/send_prompt/await_response/shutdown in order', async () => {
    let sentPrompt = ''
    let closed = false

    const driver: GeminiWebRunnerDomDriver = {
      ensureReady: async () => {},
      sendPrompt: async prompt => {
        sentPrompt = prompt
      },
      readLatestResponseState: async () => ({
        text: 'Gemini said\n\nA_PROTO_TEST',
        generationActive: false,
      }),
      close: async () => {
        closed = true
      },
    }

    const input = Readable.from([
      encodeProtocolMessage({ type: 'init', request_id: 'init-1' }),
      encodeProtocolMessage({
        type: 'send_prompt',
        request_id: 'req-1',
        prompt: 'ping',
      }),
      encodeProtocolMessage({ type: 'await_response', request_id: 'req-1' }),
      encodeProtocolMessage({ type: 'shutdown', request_id: 'stop-1' }),
    ])
    const output = createOutputCapture()

    let now = 0
    await runGeminiWebRunnerWithIO({
      input,
      output: output.stream,
      createDriver: () => driver,
      now: () => {
        now += 1
        return now
      },
      sleep: async () => {},
      responseStableMs: 0,
      responsePollMs: 0,
      responseTimeoutMs: 1_000,
    })

    const events = output
      .read()
      .trim()
      .split('\n')
      .map(line => decodeProtocolLine(line) as GeminiRunnerEvent)

    expect(events.map(event => event.type)).toEqual([
      'ack',
      'ack',
      'ack',
      'response_complete',
      'ack',
    ])
    expect((events[0] as Extract<GeminiRunnerEvent, { type: 'ack' }>).command).toBe(
      'init',
    )
    expect((events[1] as Extract<GeminiRunnerEvent, { type: 'ack' }>).command).toBe(
      'send_prompt',
    )
    expect((events[2] as Extract<GeminiRunnerEvent, { type: 'ack' }>).command).toBe(
      'await_response',
    )
    const complete = events[3] as Extract<
      GeminiRunnerEvent,
      { type: 'response_complete' }
    >
    expect(complete.request_id).toBe('req-1')
    expect(complete.text).toContain('A_PROTO_TEST')
    expect((events[4] as Extract<GeminiRunnerEvent, { type: 'ack' }>).command).toBe(
      'shutdown',
    )
    expect(sentPrompt).toBe('ping')
    expect(closed).toBe(true)
  })
})
