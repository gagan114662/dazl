// Quest live check (test input). Runs THIS directory's lib (deployed release code, or pre-fix swap) against the live made-up page.
import Database from 'better-sqlite3'
const L = process.argv[2] // path to web/ dir
const BASE = 'https://dazl.ai/dazl-test'
const fetchLive = async (p: string) => { const r = await fetch(BASE + p, { headers: { 'cache-control': 'no-cache' } }); return { status: r.status, body: await r.text() } }
const out: Record<string, unknown> = {}
const SITE = 'dazl.ai'
// #1208
try {
  const { migrateAllSqlite } = await import(`${L}/lib/db/sqlite-migrations.ts`); const { createJob } = await import(`${L}/lib/scan/store.ts`)
  const { crawlJob } = await import(`${L}/lib/connectors/sitecrawl.ts`); const { findWorkEmail } = await import(`${L}/lib/people/work-email.ts`)
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const ICP = { summary: 'Toronto test companies', who: ['Head of Sales'], where: ['Toronto, ON'], signals: [] }
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'saas', location: 'Toronto, ON' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(lead, job, 'dazl', null, 'Test page for dazl', `https://${SITE}/`, 'dazl finds reviewed, high-intent leads and writes cold outreach from your own Gmail', 90, 80)
  const fetched: string[] = []
  const get = async (url: string) => { const p = new URL(url).pathname; if (p === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }; const m = p === '/' ? '/' : p === '/team' || p === '/team/' ? '/team/' : null; if (!m) return { status: 404, body: '', finalUrl: url }; const r = await fetchLive(m); fetched.push(BASE + m + ' ' + r.status); return { status: r.status, body: r.body, finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env: { SITECRAWL_ENABLED: '1' }, now: Date.now() })
  const calls: string[] = []
  const r = await findWorkEmail(db, 'T', lead, 'Zorvina Quellbrook|Head of Sales', { env: {}, now: Math.floor(Date.now() / 1000), fetchImpl: (async (u: any) => { calls.push(String(u)); throw new Error('no provider') }) as any })
  const rows = (await import(`${L}/lib/connectors/store.ts`)).enrichmentsForLeads(db,'T',[lead])[lead] ?? []; const ident = (await import(`${L}/lib/scan/opportunity.ts`)).identityOf({id:lead,contact:null}, rows);
  out['#1208'] = { site_identity: ident ? {state: ident.state, site: ident.site} : null, live_pages_fetched: fetched, buyer: 'Zorvina Quellbrook, Head of Sales', result_status: (r as any).status, address: (r as any).row?.address ?? null, source: (r as any).row?.source_url ?? null, paid_provider_calls: calls.length }
} catch (e) { out['#1208'] = `ERROR ${(e as Error).message}` }
console.log(JSON.stringify(out, null, 1))
