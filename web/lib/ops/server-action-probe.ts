// #1088: this app has NO server actions (no 'use server' anywhere; test/server-action-probes-1088.test.ts keeps it so), so a
// request that carries a Next-Action header is a probe. Next would look the action up, fail, and print a stack trace per request
// ("Failed to find Server Action", "Server Reference ID did not match"): 706 of them in 41 h on prod. proxy.ts answers it with a
// plain 400 instead. Pure, so it is unit-tested without the Next runtime.
export const isServerActionProbe = (h: { has(name: string): boolean }): boolean => h.has('next-action')
// The matcher entry that makes the proxy run for such a request on EVERY path (it otherwise runs for /app and /api only).
export const SERVER_ACTION_PROBE_MATCHER = { source: '/:path*', has: [{ type: 'header', key: 'next-action' }] } as const
