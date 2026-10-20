export interface LlmRequest {
  system?: string
  prompt: string
  maxOutputTokens: number
}

export interface LlmResult {
  text: string
  inputTokens: number
  outputTokens: number
  model: string
}

// One implementation per vendor. Keep vendor SDK details inside the provider.
export interface LlmProvider {
  readonly name: string
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResult>
}
