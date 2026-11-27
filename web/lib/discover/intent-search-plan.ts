// Search guidance only. It leaves candidate requirements, tools and limits with Discovery.
export function intentSearchPlan(): string {
  return `- When the request requires multiple events, search for each required event separately if a combined search is sparse. Use sources suited to each event and confirm that they refer to the same buyer. Use an independently readable source to verify each required qualifier; keep the returned signal and quote limited to what the cited proof page itself states.
- When the requested buyer is a person who took a public action, find the public action first on the requested source, then verify the person's organization independently. A profile or a post about the same topic is not evidence of an engagement. If a page cannot be read, look for an openly readable source documenting the same person and action. Return a candidate only when its proof and organization meet the same evidence requirements as any other lead.`
}
