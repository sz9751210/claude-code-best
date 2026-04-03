import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { createInterface } from 'readline'
import {
  decodeProtocolLine,
  encodeProtocolMessage,
  type GeminiRunnerCommand,
  type GeminiRunnerEvent,
} from './protocol.js'

type ResponseCompleteEvent = Extract<
  GeminiRunnerEvent,
  { type: 'response_complete' }
>

type PendingEntry = {
  resolve: (value: ResponseCompleteEvent) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

export class GeminiWebRunnerError extends Error {
  code: string
  retryable: boolean

  constructor(params: { code: string; message: string; retryable: boolean }) {
    super(`${params.code}: ${params.message}`)
    this.name = 'GeminiWebRunnerError'
    this.code = params.code
    this.retryable = params.retryable
  }
}

export class GeminiWebRunnerClient {
  private child: ChildProcessWithoutNullStreams | null
  private pending = new Map<string, PendingEntry>()
  private started = false
  private readonly spawningEnabled: boolean

  constructor(options?: { spawningEnabled?: boolean }) {
    this.child = null
    this.spawningEnabled = options?.spawningEnabled ?? true
  }

  static createForTest(): GeminiWebRunnerClient {
    return new GeminiWebRunnerClient({ spawningEnabled: false })
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }
    this.started = true
    if (!this.spawningEnabled) {
      return
    }

    this.child = spawn(process.execPath, [process.argv[1]!, '--gemini-web-runner'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', line => {
      this.handleLine(line)
    })

    this.child.on('exit', (code, signal) => {
      this.rejectAllPending(
        new Error(
          `Gemini runner exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
        ),
      )
      this.child = null
      this.started = false
    })

    this.child.on('error', err => {
      this.rejectAllPending(err)
    })

    // Runner init handshake gives early signal if runner process is misconfigured.
    await this.send({
      type: 'init',
      request_id: randomUUID(),
    })
  }

  async send(command: GeminiRunnerCommand): Promise<void> {
    if (!this.started) {
      await this.start()
    }
    if (!this.spawningEnabled) {
      return
    }
    if (!this.child) {
      throw new Error('Gemini runner is not started')
    }
    this.child.stdin.write(encodeProtocolMessage(command))
  }

  awaitResponse(
    requestId: string,
    timeoutMs = parseInt(process.env.GEMINI_WEB_RESPONSE_TIMEOUT_MS || '', 10) ||
      180_000,
  ): Promise<ResponseCompleteEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new GeminiWebRunnerError({
            code: 'response_timeout',
            message: 'Timed out waiting for Gemini Web response',
            retryable: true,
          }),
        )
      }, timeoutMs)

      this.pending.set(requestId, { resolve, reject, timeout })
    })
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    if (this.spawningEnabled && this.child) {
      try {
        await this.send({
          type: 'shutdown',
          request_id: randomUUID(),
        })
      } catch {
        // Ignore shutdown command errors; we still terminate below.
      }
      this.child.kill()
      this.child = null
    }

    this.rejectAllPending(new Error('Gemini runner stopped'))
    this.started = false
  }

  injectLine(line: string): void {
    this.handleLine(line)
  }

  private handleLine(line: string): void {
    let message: GeminiRunnerEvent
    try {
      message = decodeProtocolLine(line) as GeminiRunnerEvent
    } catch {
      return
    }

    if (message.type !== 'response_complete' && message.type !== 'error') {
      return
    }

    const entry = this.pending.get(message.request_id)
    if (!entry) {
      return
    }

    this.pending.delete(message.request_id)
    if (entry.timeout) {
      clearTimeout(entry.timeout)
    }

    if (message.type === 'response_complete') {
      entry.resolve(message)
      return
    }

    entry.reject(
      new GeminiWebRunnerError({
        code: message.code,
        message: message.message,
        retryable: message.retryable,
      }),
    )
  }

  private rejectAllPending(error: Error): void {
    const values = [...this.pending.values()]
    this.pending.clear()
    for (const entry of values) {
      if (entry.timeout) {
        clearTimeout(entry.timeout)
      }
      entry.reject(error)
    }
  }
}
