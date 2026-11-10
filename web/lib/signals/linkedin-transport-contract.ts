// What any future LinkedIn transport must prove before it can be injected (#192). Nothing here talks to LinkedIn: it is the conformance suite and the status mapping a reviewed
// integration is held to. The people reader (linkedin-people.ts) already enforces these at runtime; this lets a transport be checked BEFORE activation, with stubs.
import type { LinkedInTransport, TransportRequest, TransportResult } from './linkedin-people.ts'
import { MAX_ITEMS } from './linkedin-people.ts'

// Upstream HTTP-style outcome -> the transport's result status. Anything unlisted is a plain error, never "ok" and never "empty".
export function mapUpstreamStatus(status: number): 'ok' | 'throttled' | 'unauthorized' | 'challenge' | 'error' {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 429 || status === 503) return 'throttled'      // rate limited / asked to back off
  if (status === 401 || status === 403) return 'unauthorized'   // revoked, expired or not permitted: stop, do not retry
  if (status === 999 || status === 451) return 'challenge'      // bot-challenge / legal block: stop
  return 'error'
}

// How long an aborted in-flight call may take to settle, and how long we watch afterwards for a late request. Exported so tests can use short stubs.
export const IN_FLIGHT_SETTLE_MS = 250, IN_FLIGHT_WATCH_MS = 60
export interface ContractReport { ok: boolean; failures: string[] }
// The checks a transport must pass (run against a stubbed upstream that counts the requests it actually receives):
//   - one fetch() = exactly one upstream request (no pagination, retry or fan-out inside a call)
//   - at most maxItems items; every url is a public profile URL; no field beyond url/title/quote/date
//   - it honours the abort signal, both when already raised AND while a call is in flight (stops, settles promptly, makes no further upstream request after the abort)
export async function checkTransportContract(make: (upstream: { requests: number }) => LinkedInTransport): Promise<ContractReport> {
  const failures: string[] = []
  const req = (signal: AbortSignal): TransportRequest => ({ kind: 'people', query: 'HR manager Ohio', tenantId: 'T', maxItems: MAX_ITEMS, signal })
  // 1. one call = one upstream request
  const up = { requests: 0 }
  const r: TransportResult = await make(up).fetch(req(new AbortController().signal))
  if (up.requests !== 1) failures.push(`one call made ${up.requests} upstream requests (must be exactly 1)`)
  if (r.status === 'ok') {
    if (r.items.length > MAX_ITEMS) failures.push(`returned ${r.items.length} items (max ${MAX_ITEMS})`)
    for (const it of r.items) {
      const extra = Object.keys(it).filter(k => !['url', 'title', 'quote', 'date'].includes(k))
      if (extra.length) failures.push(`item carries fields beyond url/title/quote/date: ${extra.join(', ')}`)
      if (!/^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9%_-]{2,100}\/?$/.test(it.url)) failures.push(`not a public profile URL: ${it.url.slice(0, 60)}`)
    }
    if ((r.upstream_requests ?? 1) !== up.requests) failures.push(`reports ${r.upstream_requests ?? 1} upstream requests but made ${up.requests}`)
  }
  // 2. honours the abort: an already-aborted signal makes no upstream request
  const aborted = new AbortController(); aborted.abort()
  const up2 = { requests: 0 }
  await make(up2).fetch(req(aborted.signal)).catch(() => undefined)
  if (up2.requests > 0) failures.push('made an upstream request after the abort signal was raised')
  // 3. honours an abort raised WHILE the call is running (the hard-deadline case): the check above only covers a signal aborted before fetch began, so a transport that tests
  //    `signal.aborted` once on entry and then ignores later aborts would pass it. Start the call, let it get going, abort, then require that it settles promptly and that the
  //    upstream request count does not grow after the abort (no later request begins). A call that already finished before the abort proves nothing either way and is not failed.
  const up3 = { requests: 0 }, inflight = new AbortController()
  let settled = false
  const running = make(up3).fetch(req(inflight.signal)).then(() => undefined, () => undefined).then(() => { settled = true })
  await new Promise(r => setTimeout(r, 5))
  const atAbort = up3.requests; inflight.abort()
  await Promise.race([running, new Promise(r => setTimeout(r, IN_FLIGHT_SETTLE_MS))])
  if (!settled) failures.push(`still running ${IN_FLIGHT_SETTLE_MS} ms after the abort signal was raised mid-call`)
  await new Promise(r => setTimeout(r, IN_FLIGHT_WATCH_MS))
  if (up3.requests > atAbort) failures.push('made an upstream request after the abort signal was raised mid-call')
  return { ok: failures.length === 0, failures }
}
