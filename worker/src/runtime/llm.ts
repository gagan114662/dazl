import type { Env } from "./env";
import { QuotaError, reserveUsage } from "./plans";

export interface LlmRequest { system: string; user: string; maxTokens?: number }
export type Llm = (env: Env, request: LlmRequest) => Promise<string>;

export const anthropicLlm: Llm = async (env, request) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.LLM_MODEL ?? "claude-sonnet-4-5",
      max_tokens: request.maxTokens ?? 800,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    }),
  });
  if (!response.ok) throw new Error(`anthropic ${response.status}`);
  const data = await response.json<{ content: Array<{ type: string; text?: string }> }>();
  return data.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
};

// Swappable for tests (and future provider failover).
let activeLlm: Llm = anthropicLlm;
export function setLlmForTests(llm: Llm | null): void {
  activeLlm = llm ?? anthropicLlm;
}

export { QuotaError };

// Metered LLM call: atomically reserves one llm_call from the tenant's monthly
// quota BEFORE calling (a failed call still costs money upstream, so no refund).
export async function meteredLlm(env: Env, tenantId: string, request: LlmRequest): Promise<string> {
  const reservation = await reserveUsage(env.DB, tenantId, "llm_call");
  if (!reservation.reserved) throw new QuotaError("llm_call", reservation);
  return activeLlm(env, request);
}

// Extract the first JSON object from model output (models sometimes wrap it
// in prose or code fences). Returns null if none parses.
export function extractJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { return null; }
}
