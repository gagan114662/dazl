import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4-5",
  modelContextWindowTokens: 200_000,
  defaultTools: true,
});
