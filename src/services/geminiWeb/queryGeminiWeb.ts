import { randomUUID } from 'crypto'
import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import type { AssistantMessage, Message } from 'src/types/message.js'
import { createAssistantMessage } from 'src/utils/messages.js'
import {
  GeminiWebRunnerClient,
  GeminiWebRunnerError,
} from './runnerClient.js'

export async function runGeminiWebTurn(params: {
  prompt: string
  invoke: () => Promise<{ text: string }>
}): Promise<{ text: string }> {
  try {
    return await params.invoke()
  } catch (error) {
    if (!isRetryableGeminiError(error)) {
      throw error
    }
    return await params.invoke()
  }
}

export async function queryGeminiWeb(params: {
  messages: Message[]
  runnerClient?: GeminiWebRunnerClient
  signal?: AbortSignal
}): Promise<AssistantMessage> {
  const prompt = buildGeminiPrompt(params.messages)
  const client = params.runnerClient ?? new GeminiWebRunnerClient()
  const ownsClient = !params.runnerClient

  if (!prompt.trim()) {
    return createAssistantMessage({ content: '' })
  }

  if (params.signal?.aborted) {
    throw new APIUserAbortError()
  }

  await client.start()

  try {
    const result = await runGeminiWebTurn({
      prompt,
      invoke: async () => {
        if (params.signal?.aborted) {
          throw new APIUserAbortError()
        }

        const requestId = randomUUID()
        await client.send({
          type: 'send_prompt',
          request_id: requestId,
          prompt,
        })
        await client.send({
          type: 'await_response',
          request_id: requestId,
        })
        const response = await client.awaitResponse(requestId)
        return { text: response.text }
      },
    })

    return createAssistantMessage({
      content: result.text,
    })
  } finally {
    if (ownsClient) {
      await client.stop()
    }
  }
}

export function buildGeminiPrompt(messages: Message[]): string {
  const lines: string[] = []

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }
    const role = message.type === 'user' ? 'User' : 'Assistant'
    const text = extractTextContent(message.message?.content)
    if (!text) {
      continue
    }
    lines.push(`${role}: ${text}`)
  }

  return lines.join('\n\n')
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim()
  }
  if (!Array.isArray(content)) {
    return ''
  }

  const textBlocks = content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === 'object' && block !== null && 'type' in block,
    )
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text!.trim())
    .filter(Boolean)

  return textBlocks.join('\n\n')
}

function isRetryableGeminiError(error: unknown): boolean {
  if (error instanceof GeminiWebRunnerError) {
    return error.retryable
  }
  if (!error || typeof error !== 'object') {
    return false
  }
  return Boolean((error as { retryable?: boolean }).retryable)
}
