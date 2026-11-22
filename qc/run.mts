// Quest live check (test input). Runs THIS directory's lib (deployed release code, or pre-fix swap) against the live made-up page.
import Database from 'better-sqlite3'
const L = process.argv[2] // path to web/ dir
const BASE = 'https://dazl.ai/dazl-test'
const fetchLive = async (p: string) => { const r = await fetch(BASE + p, { headers: { 'cache-control': 'no-cache' } }); return { status: r.status, body: await r.text() } }
const out: Record<string, unknown> = {}
const SITE = 'dazl.ai'
// #1207
try {
  const ep = await import(`${L}/lib/people/email-pattern.ts`); const sc = await import(`${L}/lib/connectors/sitecrawl.ts`)
  const page = (await fetchLive('/team2/')).body
  const seen = new Map<string, any>()
  for (const a of ep.personalAddresses(page, SITE)) { const c = sc.addressContexts(page, a.at); const h = seen.get(a.address); if (h) h.ctx.push(...c); else seen.set(a.address, { address: a.address, url: `${BASE}/team2/`, ctx: c }) }
  const s = [...seen.values()]; const n = { first: 'zorvina', last: 'quellbrook(' }; const r: Record<string, unknown> = {}
  for (const [k, f] of Object.entries({ publishedFor: () => ep.publishedFor(n, s)?.address ?? null, sameNamedPublication: () => ep.sameNamedPublication(n, s[0]?.ctx), singleNamePairing: () => ep.singleNamePairing('zorvina', n, s[0]?.ctx) })) { try { r[k] = f() } catch (e) { r[k] = `THREW ${(e as Error).name}: ${(e as Error).message}` } }
  out['#1207'] = { addresses_on_page: s.map(x => x.address), buyer: 'Zorvina Quellbrook(', ...r }
} catch (e) { out['#1207'] = `LOAD ERROR ${(e as Error).message}` }
// #1208
try {
  const { migrateAllSqlite } = await import(`${L}/lib/db/sqlite-migrations.ts`); const { createJob } = await import(`${L}/lib/scan/store.ts`)
  const { crawlJob } = await import(`${L}/lib/connectors/sitecrawl.ts`); const { findWorkEmail } = await import(`${L}/lib/people/work-email.ts`)
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const ICP = { summary: 'Toronto test companies', who: ['Head of Sales'], where: ['Toronto, ON'], signals: [] }
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'saas', location: 'Toronto, ON' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(lead, job, 'Quellbrook Test Co', null, 'Made-up test company', `https://${SITE}/`, 'Quellbrook Test Co is a made-up company page', 90, 80)
  const fetched: string[] = []
  const get = async (url: string) => { const p = new URL(url).pathname; if (p === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }; const m = p === '/' ? '/' : p === '/team' || p === '/team/' ? '/team/' : null; if (!m) return { status: 404, body: '', finalUrl: url }; const r = await fetchLive(m); fetched.push(BASE + m + ' ' + r.status); return { status: r.status, body: r.body, finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env: { SITECRAWL_ENABLED: '1' }, now: Date.now() })
  const calls: string[] = []
  const r = await findWorkEmail(db, 'T', lead, 'Zorvina Quellbrook|Head of Sales', { env: {}, now: Math.floor(Date.now() / 1000), fetchImpl: (async (u: any) => { calls.push(String(u)); throw new Error('no provider') }) as any })
  out['#1208'] = { live_pages_fetched: fetched, buyer: 'Zorvina Quellbrook, Head of Sales', result_status: (r as any).status, address: (r as any).row?.address ?? null, source: (r as any).row?.source_url ?? null, paid_provider_calls: calls.length }
} catch (e) { out['#1208'] = `ERROR ${(e as Error).message}` }
// #1139
try {
  const sb = await import(`${L}/lib/scan/scoreboard.ts`)
  const page = (await fetchLive('/careers/')).body
  const posts = [...page.matchAll(/data-board="([^"]+)" data-posted="([^"]+)">([^<]+)</g)].map(m => ({ board: m[1], date: m[2], title: m[3] }))
  out['#1139'] = posts.map(p => { const signal = `Posted a ${p.title} role on ${p.board}`; return { signal, counted_as_hiring: sb.isHiringTrigger(signal, null), timing: sb.surfaceStoredIntent({ intent: 4, event_date: p.date, event_date_proof: 'ats_structured', signal_kind: null, signal }, { now: new Date('2026-11-21T12:00:00Z') }).timing } })
} catch (e) { out['#1139'] = `ERROR ${(e as Error).message}` }
console.log(JSON.stringify(out, null, 1))
