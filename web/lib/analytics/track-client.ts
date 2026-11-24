// Browser side of the funnel events only the page knows (#1616): posted to this app's own /api/track, which checks the
// event and its properties against the allowlist and sends it on (lib/analytics/track.ts). Each distinct event once per
// page load; a failed send is dropped. Never throws. Off (no request at all) unless NEXT_PUBLIC_POSTHOG_KEY was set at build.
import type { ClientEvent, FunnelProps } from './track.ts'

const seen = new Set<string>()
// Next inlines NEXT_PUBLIC_ variables at build; a bundle built without that (the UI tests' esbuild bundle) has no
// `process` in the browser, so reading it must not throw.
function buildKey(): string | undefined {
  try { return process.env.NEXT_PUBLIC_POSTHOG_KEY } catch { return undefined }
}
export function trackClient(event: ClientEvent, props: FunnelProps = {}, w: { fetch: typeof fetch } | undefined = typeof window === 'undefined' ? undefined : window, key?: string): boolean {
  try {
    if (!w || !(key ?? buildKey())) return false
    const body = JSON.stringify({ event, props })
    if (seen.has(body) || seen.size >= 50) return false
    seen.add(body)
    void w.fetch('/api/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {})
    return true
  } catch { return false }
}
export const resetTrackClient = () => seen.clear()
