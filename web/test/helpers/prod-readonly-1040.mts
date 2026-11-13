// One-off proof for #1040 (not part of npm test): runs the REAL homeResults / replyReadingOn code against prod rows through
// the ops door's read-only SQL endpoint (one SELECT per call, params inlined as literals). Prints counts only, no names.
import { homeResults } from '../../lib/outreach/home-results.ts'
import { replyReadingOn } from '../../lib/outreach/reply-reading.ts'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
const T = readFileSync(`${homedir()}/.config/hermes/dazl_ops_token`, 'utf8').trim()
const lit = (v: unknown) => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
const inline = (sql: string, p: unknown[] = []) => { let i = 0; return sql.replace(/\?/g, () => lit(p[i++])) }
let queries = 0
const q = async (sql: string, p: unknown[] = []) => {
  queries++
  const u = new URL('https://staging.dazl.ai/__ops/db'); u.searchParams.set('env', process.env.OPS_ENV ?? 'prod'); u.searchParams.set('q', inline(sql, p).replace(/\s+/g, ' '))
  const r = await fetch(u, { headers: { authorization: `Bearer ${T}` } }); const j = await r.json() as { rows?: unknown[]; error?: string }
  if (!r.ok || !j.rows) throw new Error(`ops db ${r.status}: ${j.error ?? ''}`)
  return j.rows
}
const db = { kind: 'sqlite', all: q, get: async (s: string, p?: unknown[]) => (await q(s, p))[0], run: async () => { throw new Error('read-only') } } as never
const tenant = process.argv[2]
const reading = await replyReadingOn(db, tenant)
const r = await homeResults(db, tenant, Math.floor(Date.now() / 1000), reading)
if (process.env.FULL_JSON) { console.log(JSON.stringify({ ...r, latest_leads: r.latest_leads.map((l, i) => ({ ...l, id: `x${i}`, company: `Company ${i + 1} (redacted)` })), latest_replies: r.latest_replies.map((x, i) => ({ ...x, company: `Company ${i + 1} (redacted)` })) })); process.exit(0) }
console.log(JSON.stringify({ tenant: tenant.slice(0, 8), reply_reading: r.reply_reading, tiles: r.tiles,
  by_signal: r.by_signal, latest_leads: r.latest_leads.length, latest_replies: r.latest_replies.map(x => x.classification), queries }, null, 1))
