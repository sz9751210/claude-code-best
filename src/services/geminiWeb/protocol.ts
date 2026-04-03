import { jsonParse, jsonStringify } from 'src/utils/slowOperations.js'

export type GeminiRunnerCommand =
  | { type: 'init'; request_id: string }
  | { type: 'send_prompt'; request_id: string; prompt: string }
  | { type: 'await_response'; request_id: string }
  | { type: 'shutdown'; request_id: string }

export type GeminiRunnerEvent =
  | {
      type: 'ack'
      request_id: string
      command: GeminiRunnerCommand['type']
    }
  | {
      type: 'response_complete'
      request_id: string
      text: string
      timings: { total_ms: number }
    }
  | {
      type: 'error'
      request_id: string
      code: string
      message: string
      retryable: boolean
    }

export type GeminiProtocolMessage = GeminiRunnerCommand | GeminiRunnerEvent

export function encodeProtocolMessage(msg: GeminiProtocolMessage): string {
  return `${jsonStringify(msg)}\n`
}

export function decodeProtocolLine(line: string): GeminiProtocolMessage {
  const parsed = jsonParse(line) as unknown
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new Error('Invalid Gemini protocol message')
  }
  return parsed as GeminiProtocolMessage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
