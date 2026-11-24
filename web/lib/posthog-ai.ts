import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { Anthropic as PostHogAnthropic } from '@posthog/ai/anthropic'
import { PostHog } from 'posthog-node'

interface AiContext {
  distinctId: string
  sessionId: string | null
  traceId: string
}

const context = new AsyncLocalStorage<AiContext>()
let client: PostHog | null | undefined
let warned = false

function getClient(): PostHog | null {
  if (client !== undefined) return client
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST
  if (!token || !host) {
    client = null
    if (!warned && process.env.NODE_ENV !== 'production') {
      warned = true
      const missing = token ? 'NEXT_PUBLIC_POSTHOG_HOST' : 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN'
      console.warn(`${missing} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missing} is configured`)
    }
    return client
  }
  client = new PostHog(token, {
    host,
    privacyMode: false,
    enableExceptionAutocapture: false,
  })
  return client
}

export function withAiObservability<T>(input: Pick<AiContext, 'distinctId' | 'sessionId'>, work: () => T): T {
  if (context.getStore()) return work()
  return context.run({ ...input, traceId: randomUUID() }, work)
}

export function createAnthropicClient(options: NonNullable<ConstructorParameters<typeof Anthropic>[0]> & { apiKey: string }): Anthropic {
  const current = context.getStore()
  if (!current) return new Anthropic(options)
  const posthog = getClient()
  return posthog ? new PostHogAnthropic({ ...options, posthog }) as unknown as Anthropic : new Anthropic(options)
}

export function anthropicPostHogOptions() {
  const current = context.getStore()
  return current ? {
    posthogDistinctId: current.distinctId,
    posthogTraceId: current.traceId,
    posthogProperties: { $ai_session_id: current.sessionId },
  } : {}
}

export function captureAiGeneration(input: {
  provider: 'anthropic' | 'openai'
  model: string | null
  prompt: string
  completion: string
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  maxTokens: number
  latency: number
  stopReason?: string
}) {
  const current = context.getStore()
  if (!current) return
  const posthog = getClient()
  if (!posthog) return
  try {
    posthog.captureAi({
      distinctId: current.distinctId,
      event: '$ai_generation',
      properties: {
        $ai_trace_id: current.traceId,
        $ai_session_id: current.sessionId,
        $ai_model: input.model,
        $ai_provider: input.provider,
        $ai_input: [{ role: 'user', content: input.prompt }],
        $ai_input_tokens: input.inputTokens,
        $ai_output_choices: [{ role: 'assistant', content: input.completion }],
        $ai_output_tokens: input.outputTokens,
        $ai_cache_read_input_tokens: input.cacheReadInputTokens,
        $ai_cache_creation_input_tokens: input.cacheCreationInputTokens,
        $ai_max_tokens: input.maxTokens,
        $ai_latency: input.latency,
        ...(input.stopReason ? { $ai_stop_reason: input.stopReason } : {}),
      },
    })
  } catch {
    // Observability never affects an LLM result.
  }
}
