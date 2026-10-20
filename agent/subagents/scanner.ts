import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Scans 30+ public sources for buying signals. For each signal found, extracts: prospect name, company, signal type, source URL, and a one-sentence reason they might need the owner's service. Cites every source. Never fabricates a lead.",
  model: "anthropic/claude-haiku-4-5",
  modelContextWindowTokens: 200_000,
});
