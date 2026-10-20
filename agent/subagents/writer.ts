import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Writes outreach copy and marketing content. Given a prospect's signal and context, writes hyper-personalised emails, follow-ups, LinkedIn notes, ad copy, social posts, or email sequences. Output is production-ready copy — never placeholders.",
  model: "anthropic/claude-sonnet-4-5",
  modelContextWindowTokens: 200_000,
});
