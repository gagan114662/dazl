import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

function getModel() {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) return null;
  const anthropic = createAnthropic({ apiKey: key });
  return anthropic("claude-haiku-4-5");
}

async function generate(prompt: string): Promise<string> {
  const model = getModel();
  if (!model) return "__NO_API_KEY__";
  const { text } = await generateText({ model, prompt, maxOutputTokens: 1500 });
  return text;
}

function tryParse(text: string, fallback: unknown): unknown {
  if (text === "__NO_API_KEY__") return null;
  const m = text.match(/```(?:json)?\s*([\s\S]+?)```/) ?? text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  try { return JSON.parse(m ? (m[1] ?? text) : text); }
  catch { return fallback; }
}

export default defineTool({
  description:
    "Generate marketing content using AI (claude-haiku-4-5). Requires ANTHROPIC_API_KEY. Types: ad_copy (3 headline+body+CTA variations), social_post (5 platform-native posts), email_sequence (3-email Day1/3/7 drip), landing_page (hero+features+proof+CTA). Returns null for each content type if API key is missing.",
  inputSchema: z.object({
    type: z.enum(["ad_copy", "social_post", "email_sequence", "landing_page"]).describe("Content type"),
    business_description: z.string().min(1).describe("What the business does and who it serves"),
    target_audience: z.string().min(1).describe("Who you are targeting"),
    platform: z.string().optional().describe("Platform for social_post: Twitter, LinkedIn, Instagram"),
    tone: z.string().optional().describe("Brand tone: professional, casual, bold, empathetic"),
  }),
  async execute({ type, business_description, target_audience, platform, tone }) {
    const base = `Business: ${business_description}\nAudience: ${target_audience}\nTone: ${tone ?? "professional"}`;
    const missing = !process.env["ANTHROPIC_API_KEY"];

    if (type === "ad_copy") {
      const text = await generate(
        `${base}\n\nWrite 3 ad copy variations. Each has:\n- headline (max 8 words)\n- body (max 30 words)\n- cta (max 5 words)\n\nRespond with JSON array: [{headline, body, cta}]`
      );
      return { type, variations: tryParse(text, []), missing_api_key: missing };
    }

    if (type === "social_post") {
      const p = platform ?? "LinkedIn";
      const text = await generate(
        `${base}\nPlatform: ${p}\n\nWrite 5 social posts for ${p}. Native tone, correct length, relevant hashtags.\n\nRespond with JSON array of 5 strings.`
      );
      return { type, platform: p, posts: tryParse(text, []), missing_api_key: missing };
    }

    if (type === "email_sequence") {
      const text = await generate(
        `${base}\n\nWrite a 3-email drip sequence:\n- Day 1: introduce and hook (personalised opener)\n- Day 3: add value, case study or stat\n- Day 7: soft close with clear CTA\n\nRespond with JSON array: [{day, subject, body}]`
      );
      return { type, sequence: tryParse(text, []), missing_api_key: missing };
    }

    if (type === "landing_page") {
      const text = await generate(
        `${base}\n\nWrite landing page copy: hero_headline, hero_subheadline, 3-item features array, 2-item social_proof array, cta.\n\nRespond with JSON: {hero_headline, hero_subheadline, features, social_proof, cta}`
      );
      return { type, copy: tryParse(text, {}), missing_api_key: missing };
    }

    return { type, error: "Unknown content type" };
  },
});
