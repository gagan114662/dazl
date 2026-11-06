// Stand-in for lib/scan/icp-from-site.ts in the site-read route runtime: the page counts as fetched and readable, so the
// route's trial admission runs exactly where the real read would run it. The free read ALWAYS answers (the ported
// module's floor); what the admission decides rides on it:
//   refused            -> the free read with `trial` = the refusal reason (nothing reserved or handed over);
//   admitted, default  -> one call on the admission's operator key (recorded), settled to a reported cost, funded draft;
//   'guard_refused'    -> the read's own guard refused before any call: released, free read + trial 'spend_unavailable';
//   'call_failed'      -> a provider error after the call: settled at the full reserve, free read + trial 'read_failed'.
// `next.error` makes the next read end with that typed error before any admission (an own-key read refused by the
// owner's spend pool, 'spend_limit'; 'key_unreadable'; ...), so the route's mapping of each is checked on the real handler.
import type { SiteReadAdmission, SiteReadRefusal } from '../../lib/scan/trial-site-read.ts'
export const handedKeys: string[] = []
export const calls = { n: 0 }
// `next.throws` makes the next read throw (an unexpected failure inside the read), for the route's record-then-rethrow path.
export const next: { error: string | null; outcome: 'ok' | 'guard_refused' | 'call_failed'; throws?: boolean } = { error: null, outcome: 'ok' }
const FREE = { free: true as const, source: 'https://acme.example/', site: 'acme.example', facts: [{ kind: 'title' as const, text: 'Acme', source: 'https://acme.example/' }] }
export async function icpFromWebsite(_db: unknown, _tenantId: string, _url: string, deps: { trial?: () => Promise<SiteReadAdmission> }): Promise<{ free: true; source: string; site: string; facts: { kind: 'title'; text: string; source: string }[]; trial?: SiteReadRefusal } | { icp: { summary: string }; source: string; sells: string; funded: 'trial' } | { error: string }> {
  calls.n++
  if (next.throws) { next.throws = false; throw new Error('read exploded') }
  if (next.error) { const error = next.error; next.error = null; return { error } }
  if (!deps.trial) return FREE
  const a = await deps.trial()
  if (!a.ok) return { ...FREE, trial: a.reason }
  handedKeys.push(a.key.key)
  if (next.outcome === 'guard_refused') { next.outcome = 'ok'; await a.release(); return { ...FREE, trial: 'spend_unavailable' } }
  if (next.outcome === 'call_failed') { next.outcome = 'ok'; await a.settle(null); return { ...FREE, trial: 'read_failed' } }
  await a.settle(0.01)
  return { icp: { summary: 'Sales ops.' }, source: 'https://acme.example/', sells: 'CRM cleanup', funded: 'trial' }
}
