// Structured JSON logs (one line each) so Workers Logs / log drains can filter
// by tenant, event, and level. Never pass secrets or full request bodies.
export function logEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
