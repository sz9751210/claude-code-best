import { createInterface } from 'readline'
import { isResponseStable } from './completionDetector.js'
import { GeminiWebDomDriver } from './domDriver.js'
import {
  decodeProtocolLine,
  encodeProtocolMessage,
  type GeminiRunnerCommand,
  type GeminiRunnerEvent,
} from './protocol.js'

type ActiveRequest = {
  requestId: string
  startedAt: number
}

export type GeminiWebRunnerDomDriver = Pick<
  GeminiWebDomDriver,
  'ensureReady' | 'sendPrompt' | 'readLatestResponseState' | 'close'
>

type GeminiWebRunnerIOOptions = {
  input?: NodeJS.ReadableStream
  output?: Pick<NodeJS.WritableStream, 'write'>
  createDriver?: () => GeminiWebRunnerDomDriver
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  responseStableMs?: number
  responsePollMs?: number
  responseTimeoutMs?: number
}

class RunnerCommandError extends Error {
  code: string
  retryable: boolean

  constructor(params: { code: string; message: string; retryable: boolean }) {
    super(params.message)
    this.name = 'RunnerCommandError'
    this.code = params.code
    this.retryable = params.retryable
  }
}

export async function runGeminiWebRunner(): Promise<void> {
  await runGeminiWebRunnerWithIO()
}

export async function runGeminiWebRunnerWithIO(
  options: GeminiWebRunnerIOOptions = {},
): Promise<void> {
  const driver =
    options.createDriver?.() ?? ((new GeminiWebDomDriver() as GeminiWebRunnerDomDriver))
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const sleep = options.sleep ?? Bun.sleep
  const now = options.now ?? Date.now
  const responseStableMs =
    options.responseStableMs ??
    (parseInt(process.env.GEMINI_WEB_RESPONSE_STABLE_MS || '', 10) || 2000)
  const responsePollMs =
    options.responsePollMs ??
    (parseInt(process.env.GEMINI_WEB_RESPONSE_POLL_MS || '', 10) || 250)
  const responseTimeoutMs =
    options.responseTimeoutMs ??
    (parseInt(process.env.GEMINI_WEB_RESPONSE_TIMEOUT_MS || '', 10) || 180_000)

  const rl = createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  let activeRequest: ActiveRequest | null = null

  const writeEvent = (event: GeminiRunnerEvent): void => {
    output.write(encodeProtocolMessage(event))
  }

  const writeError = (params: {
    requestId: string
    code: string
    message: string
    retryable: boolean
  }): void => {
    writeEvent({
      type: 'error',
      request_id: params.requestId,
      code: params.code,
      message: params.message,
      retryable: params.retryable,
    })
  }

  const assertNoActiveRequest = (nextRequestId: string): void => {
    if (!activeRequest) {
      return
    }
    writeError({
      requestId: nextRequestId,
      code: 'concurrency_violation',
      message: 'Previous request has not completed',
      retryable: false,
    })
    throw new RunnerCommandError({
      code: 'concurrency_violation',
      message: 'Previous request has not completed',
      retryable: false,
    })
  }

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue
      }

      let command: GeminiRunnerCommand
      try {
        command = parseCommand(line)
      } catch (error) {
        writeError({
          requestId: 'unknown',
          code: 'invalid_command',
          message: toErrorMessage(error),
          retryable: false,
        })
        continue
      }

      try {
        switch (command.type) {
          case 'init':
            await driver.ensureReady()
            writeEvent({
              type: 'ack',
              request_id: command.request_id,
              command: command.type,
            })
            break

          case 'send_prompt':
            assertNoActiveRequest(command.request_id)
            await driver.ensureReady()
            await driver.sendPrompt(command.prompt)
            activeRequest = {
              requestId: command.request_id,
              startedAt: now(),
            }
            writeEvent({
              type: 'ack',
              request_id: command.request_id,
              command: command.type,
            })
            break

          case 'await_response':
            if (!activeRequest) {
              throw new RunnerCommandError({
                code: 'no_active_request',
                message: 'No active request to await',
                retryable: false,
              })
            }
            if (activeRequest.requestId !== command.request_id) {
              throw new RunnerCommandError({
                code: 'request_mismatch',
                message: 'await_response request_id does not match active request',
                retryable: false,
              })
            }

            writeEvent({
              type: 'ack',
              request_id: command.request_id,
              command: command.type,
            })

            {
              let lastText = ''
              let lastTextChangeAt = now()

              while (true) {
                const currentNow = now()
                if (currentNow - activeRequest.startedAt > responseTimeoutMs) {
                  throw new RunnerCommandError({
                    code: 'response_timeout',
                    message: 'Timed out waiting for Gemini Web response',
                    retryable: true,
                  })
                }

                const { text, generationActive } =
                  await driver.readLatestResponseState()
                if (text !== lastText) {
                  lastText = text
                  lastTextChangeAt = currentNow
                }

                if (
                  lastText.trim().length > 0 &&
                  isResponseStable({
                    generationActive,
                    lastTextChangeAt,
                    now: currentNow,
                    stableMs: responseStableMs,
                  })
                ) {
                  writeEvent({
                    type: 'response_complete',
                    request_id: command.request_id,
                    text: lastText,
                    timings: {
                      total_ms: currentNow - activeRequest.startedAt,
                    },
                  })
                  activeRequest = null
                  break
                }

                await sleep(responsePollMs)
              }
            }
            break

          case 'shutdown':
            writeEvent({
              type: 'ack',
              request_id: command.request_id,
              command: command.type,
            })
            await driver.close()
            return
        }
      } catch (error) {
        const runnerError = toRunnerCommandError(error)
        writeError({
          requestId: command.request_id,
          code: runnerError.code,
          message: runnerError.message,
          retryable: runnerError.retryable,
        })
        activeRequest = null
      }
    }
  } finally {
    await driver.close()
  }
}

function parseCommand(line: string): GeminiRunnerCommand {
  const decoded = decodeProtocolLine(line) as unknown
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    !('type' in decoded) ||
    !('request_id' in decoded)
  ) {
    throw new Error('Invalid command payload')
  }

  const command = decoded as Record<string, unknown>
  if (typeof command.type !== 'string' || typeof command.request_id !== 'string') {
    throw new Error('Invalid command payload')
  }

  switch (command.type) {
    case 'init':
    case 'await_response':
    case 'shutdown':
      return {
        type: command.type,
        request_id: command.request_id,
      }
    case 'send_prompt':
      if (typeof command.prompt !== 'string') {
        throw new Error('send_prompt requires string prompt')
      }
      return {
        type: 'send_prompt',
        request_id: command.request_id,
        prompt: command.prompt,
      }
    default:
      throw new Error(`Unknown command: ${command.type}`)
  }
}

function toRunnerCommandError(error: unknown): RunnerCommandError {
  if (error instanceof RunnerCommandError) {
    return error
  }
  return new RunnerCommandError({
    code: 'runner_error',
    message: toErrorMessage(error),
    retryable: false,
  })
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
