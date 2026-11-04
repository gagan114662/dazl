// Replays recorded CRM provider exchanges (test/fixtures/crm) through the real pushLead. Each request must be the next
// recorded exchange (same method and path); anything else, or a recorded exchange never requested, is a problem.
// Status 0 replays a request that threw. No request leaves the process.
import { pushLead, CrmPushError } from '../../lib/crm/index.ts'
import type { RecordedCase } from '../../lib/crm/acceptance.ts'

export type ReplayOutcome = { outcome: string; externalId?: string | null; message?: string }
export async function replayCase(c: RecordedCase): Promise<{ got: ReplayOutcome; problems: string[]; requests: number }> {
  const problems: string[] = []
  let i = 0
  const f = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input)), method = init?.method ?? 'GET'
    const x = c.exchanges[i++]
    if (!x || x.method !== method || x.path !== u.pathname) {
      problems.push(`request ${i}: ${method} ${u.pathname}, recorded ${x ? `${x.method} ${x.path}` : 'nothing'}`)
      throw new TypeError('fetch failed')
    }
    if (x.status === 0) throw new TypeError(x.text ?? 'fetch failed')
    const body = [204, 205, 304].includes(x.status) ? null : x.text !== undefined ? x.text : JSON.stringify(x.body)
    return new Response(body, { status: x.status })
  }) as typeof fetch
  let got: ReplayOutcome
  try {
    const r = await pushLead({ provider: c.provider, key: c.key === 'valid' ? 'replayed-key' : 'replayed-invalid-key' }, c.lead, f)
    got = { outcome: 'ok', externalId: r.externalId, message: r.message }
  } catch (e) { got = { outcome: e instanceof CrmPushError ? e.outcome : `plain: ${(e as Error).message}` } }
  if (i < c.exchanges.length) problems.push(`${c.exchanges.length - i} recorded exchange(s) never requested`)
  return { got, problems, requests: i }
}
