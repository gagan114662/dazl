// One app instance for test/pg-tenant-routes.test.ts: its own Postgres pool on the shared schema (PT_SCHEMA), serving the
// real route handlers with the real session lookup (pg-session-loader.mjs), at the same time as a second instance
// serving the other tenant. In three phases, each started by a barrier both instances reach:
//   write - sign up and sign in through the auth routes (two sessions), store a scan with two leads and a play (query
//           scan), start checkout, take a signed Stripe webhook to Pro, open the portal, quarantine one lead
//   read  - with its own session: list scans, the latest play, export all and per scan, usage; with the other tenant's
//           ids (published by the other instance): export, cancel, quarantine, release, confirm, sign in to its email
//   end   - sign out of the first session; it must stop working on both instances, the second must still work
// Every read must return only this tenant's rows; every attempt on the other tenant must be refused or return nothing.
// Violations are printed with the ids (one JSON line). Stubbed: Stripe is a local fake (no network call is allowed), the
// webhook is a fixture signed with a test secret, and the SQLite handle is a trap (DB_PATH cannot be opened).
import { NextRequest } from 'next/server'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { withJar, type Jar } from './pg-session-headers.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'
import * as S from '../../lib/scan/store-db.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db'
// test values from the parent (neutral names: the net fence drops *KEY*/*SECRET* variables)
Object.assign(process.env, { STRIPE_WEBHOOK_SECRET: process.env.PT_WEBHOOK, STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_PRO: 'price_fixture', PUBLIC_BASE_URL: 'https://app.dazl.test' })
const stripeCalls: string[] = []
globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
  const url = String(u)
  if (!url.startsWith('https://api.stripe.com/')) throw new Error(`Unexpected network call: ${url}`)
  stripeCalls.push(`${url} ${String(init?.body)}`)
  return new Response(JSON.stringify({ url: `https://stripe.test/session?${String(init?.body)}` }), { status: 200 })
}) as typeof fetch
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.PT_SCHEMA, max: 4 })
setDb(db)
const tag = process.env.PT_TAG!, otherTag = process.env.PT_OTHER_TAG!
const email = `${tag}@example.test`, password = `pw-${tag}-${process.env.PT_PW}`
const now = Math.floor(Date.now() / 1000)

const signup = await import('../../app/api/auth/signup/route.ts')
const signin = await import('../../app/api/auth/signin/route.ts')
const signout = await import('../../app/api/auth/signout/route.ts')
const jobs = await import('../../app/api/scan/jobs/route.ts')
const latest = await import('../../app/api/scan/latest/route.ts')
const cancel = await import('../../app/api/scan/cancel/route.ts')
const exp = await import('../../app/api/leads/export/route.ts')
const quarantine = await import('../../app/api/leads/[lead]/quarantine/route.ts')
const confirm = await import('../../app/api/leads/[lead]/confirm/route.ts')
const checkout = await import('../../app/api/billing/checkout/route.ts')
const portal = await import('../../app/api/billing/portal/route.ts')
const stripe = await import('../../app/api/stripe/route.ts')
const usage = await import('../../app/api/usage/route.ts')

const req = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': `203.0.113.${tag === 'alpha' ? 5 : 6}`, ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (lead: string) => ({ params: Promise.resolve({ lead }) })
// a response, read as JSON or text, under the given cookie jar
const call = async (jar: Jar, f: () => Promise<Response>) => withJar(jar, async () => {
  const r = await f(); const text = await r.text()
  let body: unknown = text; try { body = JSON.parse(text) } catch { /* CSV */ }
  return { status: r.status, body, text }
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const barrier = async (phase: string, value: unknown = null) => {
  await db.run('INSERT INTO pt_barrier (phase, tag, value) VALUES (?, ?, ?)', [phase, tag, JSON.stringify(value)])
  for (;;) {
    const rows = await db.all<{ tag: string; value: string }>('SELECT tag, value FROM pt_barrier WHERE phase = ?', [phase])
    if (rows.length === 2) return JSON.parse(rows.find(r => r.tag !== tag)!.value)
    await sleep(5)
  }
}

const violations: string[] = []
const expect = (ok: boolean, what: string) => { if (!ok) violations.push(what) }
const leaks = (v: unknown, other: { tenant: string; job: string; query: string; leads: string[] }) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return [otherTag, other.tenant, other.job, other.query, ...other.leads, `cus_${otherTag}`].filter(m => s.includes(m))
}

// ---- write ----
await barrier('start')
const s1: Jar = new Map(), s2: Jar = new Map()
const up = await call(s1, () => signup.POST(req('/api/auth/signup', 'POST', { email, password, name: tag, business_name: `Biz ${tag}` })))
expect(up.status === 200 && s1.has('dazl_session'), `signup: ${up.status} ${up.text}`)
const inn = await call(s2, () => signin.POST(req('/api/auth/signin', 'POST', { email, password })))
expect(inn.status === 200 && s2.has('dazl_session') && s2.get('dazl_session') !== s1.get('dazl_session'), `signin: ${inn.status} ${inn.text}`)
const me = (await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]))!.id

const job = await S.createJob(db, me, { business_name: `Biz ${tag}`, industry: 'software', location: 'Toronto' }, null, now)
await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [now, job])
const lead = (n: number) => ({ name: `Pat ${n}`, company: `SECRET-${tag}-CO-${n}`, contact: `pat${n}@${tag}.example`, signal: 'Hiring', source_url: `https://${tag}.example/${n}`, score: 70, evidence_excerpt: `quote ${tag} ${n}`, event_date: '2026-10-01', date_status: 'verified', retrieved_at: now, confidence: 80, dedup_key: `${tag}${n}`, fit: 4, published_at: '2026-09-30', timing_note: `note ${tag}` })
const fin = await S.finishJob(db, { id: job, attempts: 1 }, { status: 'done', error: null, now: now + 1, leads: [lead(1), lead(2)] })
expect(fin.owned && fin.inserted.length === 2, `finish: ${JSON.stringify(fin)}`)
const leads = (await db.all<{ id: string }>('SELECT id FROM leads WHERE scan_job_id = ? ORDER BY company', [job])).map(r => r.id)
const query = await S.createQueryJob(db, me, { query: `SECRET-${tag}-PLAY`, icp: JSON.stringify({ summary: `icp ${tag}` }), runBudget: null }, now + 2)

const co = await call(s1, () => checkout.POST(req('/api/billing/checkout', 'POST', {})))
expect(co.status === 200 && String((co.body as { url?: string }).url).includes(me), `checkout: ${co.status} ${co.text}`)
const evt = readFileSync(new URL('../fixtures/stripe/checkout.session.completed.json', import.meta.url), 'utf8')
  .replaceAll('{{TENANT}}', me).replaceAll('{{CUSTOMER}}', `cus_${tag}`).replaceAll('{{SUBSCRIPTION}}', `sub_${tag}`)
  .replace(/"id": "evt_[^"]+"/, `"id": "evt_${tag}"`).replace(/"created": \d+/, `"created": ${now}`)
const t = Math.floor(Date.now() / 1000)
const sig = `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${evt}`).digest('hex')}`
const hook = await call(new Map(), () => stripe.POST(req('/api/stripe', 'POST', evt, { 'stripe-signature': sig })))
expect(hook.status === 200, `stripe webhook: ${hook.status} ${hook.text}`)
const po = await call(s1, () => portal.POST(req('/api/billing/portal', 'POST', {})))
expect(po.status === 200 && String((po.body as { url?: string }).url).includes(`cus_${tag}`), `portal: ${po.status} ${po.text}`)
const q = await call(s1, () => quarantine.POST(req(`/api/leads/${leads[1]}/quarantine`, 'POST', { reason: `held ${tag}` }), ctx(leads[1])))
expect(q.status === 200, `own quarantine: ${q.status} ${q.text}`)

// ---- read: own data, then the other tenant's ids ----
const other = await barrier('written', { tenant: me, email, job, query, leads }) as { tenant: string; email: string; job: string; query: string; leads: string[] }
const got: Record<string, { status: number; body: unknown; text: string }> = {
  jobs: await call(s1, () => jobs.GET()),
  latest: await call(s2, () => latest.GET()),
  exportAll: await call(s1, () => exp.GET(req('/api/leads/export'))),
  exportJob: await call(s2, () => exp.GET(req(`/api/leads/export?job_id=${job}`))),
  usage: await call(s1, () => usage.GET(req('/api/usage'))),
}
for (const [k, r] of Object.entries(got)) {
  expect(r.status === 200, `${k}: ${r.status}`)
  const l = leaks(r.text, other); expect(l.length === 0, `${k} returned the other tenant's ${l.join(', ')}`)
}
const listed = ((got.jobs.body as { jobs?: { id: string }[] }).jobs ?? []).map(j => j.id).sort()
expect(JSON.stringify(listed) === JSON.stringify([job, query].sort()), `jobs: ${JSON.stringify(listed)}`)
expect((got.latest.body as { query?: string }).query === `SECRET-${tag}-PLAY`, `latest play: ${got.latest.text}`)
// the quarantined lead is never exported: one row of this tenant's, none of the other's
expect(got.exportAll.text.includes(`SECRET-${tag}-CO-1`) && !got.exportAll.text.includes(`SECRET-${tag}-CO-2`), `export all: ${got.exportAll.text}`)
expect(got.exportJob.text.includes(`SECRET-${tag}-CO-1`), 'export of own scan')
expect((got.usage.body as { plan?: string }).plan === 'pro', `usage: ${got.usage.text}`)

const cross = {
  export: await call(s1, () => exp.GET(req(`/api/leads/export?job_id=${other.job}`))),
  cancel: await call(s1, () => cancel.POST(req('/api/scan/cancel', 'POST', { job_id: other.query }))),
  quarantine: await call(s1, () => quarantine.POST(req(`/api/leads/${other.leads[0]}/quarantine`, 'POST', { reason: 'x' }), ctx(other.leads[0]))),
  release: await call(s1, () => quarantine.DELETE(req(`/api/leads/${other.leads[1]}/quarantine`, 'DELETE'), ctx(other.leads[1]))),
  confirm: await call(s1, () => confirm.POST(req(`/api/leads/${other.leads[0]}/confirm`, 'POST', {}), ctx(other.leads[0]))),
  signinOther: await call(new Map(), () => signin.POST(req('/api/auth/signin', 'POST', { email: other.email, password }))),
}
expect(cross.export.status === 200 && cross.export.text.trim().split('\n').length === 1, `export of the other's scan: ${cross.export.text}`)
for (const k of ['cancel', 'quarantine', 'release', 'confirm'] as const) expect(cross[k].status === 404, `${k} on the other tenant: ${cross[k].status} ${cross[k].text}`)
expect(cross.signinOther.status === 401, `sign in to the other's email with this password: ${cross.signinOther.status}`)
for (const [k, r] of Object.entries(cross)) { const l = leaks(r.text, other); expect(l.length === 0, `cross ${k} returned ${l.join(', ')}`) }
for (const c of stripeCalls) { const l = leaks(c, other); expect(l.length === 0, `Stripe call carried ${l.join(', ')}`) }

// ---- end: sign out of one session; the other keeps working ----
await barrier('read')
const firstToken = s1.get('dazl_session')!
const out = await call(s1, () => signout.POST())
expect(out.status === 200 && !s1.has('dazl_session'), `signout: ${out.status}`)
// the signed-out token, replayed (as another instance would see it): no longer a session
const stale = await call(new Map([['dazl_session', firstToken]]), () => jobs.GET())
expect(stale.status === 401, `signed-out session still works: ${stale.status}`)
// and the token the OTHER instance signed out: dead here too (sessions live in the shared store, not per instance)
const otherSignedOut = await barrier('signedout', firstToken) as string
const theirs = await call(new Map([['dazl_session', otherSignedOut]]), () => jobs.GET())
expect(theirs.status === 401, `the other instance's signed-out session works here: ${theirs.status} ${theirs.text}`)
const still = await call(s2, () => jobs.GET())
expect(still.status === 200 && leaks(still.text, other).length === 0, `second session after signout: ${still.status}`)

await db.close()
process.stdout.write(JSON.stringify({ tag, tenant: me, job, query, leads, violations, signedOut: true }) + '\n')
