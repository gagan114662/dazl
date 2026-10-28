// One "app instance" for test/multi-instance-isolation.test.ts: its own Postgres pool on the shared schema.
//   ISO_MODE=write  ISO_TENANT=t  -> writes tenant t's rows through every Db-layer write path; prints the ids
//   ISO_MODE=read   ISO_TENANT=t ISO_OTHER=<json ids of the other tenant> -> reads, lists, exports and acts as t, both
//                   on its own data and with the other tenant's ids; prints everything it got back
import { pgDb } from '../../lib/db/client.ts'
import * as S from '../../lib/scan/store-db.ts'
import { createPasswordUser, createSession, getSessionUser, findPasswordUser } from '../../lib/auth-db.ts'
import { applyStripeEvent, createCheckoutUrl, createPortalUrl } from '../../lib/billing/stripe.ts'
import { readPlan } from '../../lib/plans.ts'
import { runAudit, recentAudits } from '../../lib/seo/audit.ts'
import { recentBriefs } from '../../lib/seo/brief.ts'
import { recentNewsjacks, approveNewsjack } from '../../lib/seo/newsjack.ts'
import { DbQueue } from '../../lib/queue/db.ts'
import { rateLimit } from '../../lib/rate-limit.ts'

const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.ISO_SCHEMA, max: 4 })
const T = process.env.ISO_TENANT!, tag = T.slice(0, 1), now = 1_800_000_000
const out = (v: unknown) => { process.stdout.write(JSON.stringify(v)) }
const stub = (async (u: string, init?: RequestInit) => {
  if (u.startsWith('https://api.stripe.com/')) return new Response(JSON.stringify({ url: `https://stripe.test/${String(init?.body)}` }), { status: 200 })
  return new Response('<html><head><title>Site title for audit</title></head><body><h1>x</h1></body></html>', { status: 200 })
}) as unknown as typeof fetch
const lookup = async () => [{ address: '93.184.216.34', family: 4 as const }]

if (process.env.ISO_MODE === 'write') {
  await createPasswordUser({ id: T, email: `${tag}@example.test`, name: tag, business_name: `Biz ${tag}`, password_hash: `hash-${tag}`, salt: `salt-${tag}` }, db)
  const session = await createSession(T, db)
  await applyStripeEvent(db, { id: `evt_${tag}`, type: 'checkout.session.completed', created: now, data: { object: { mode: 'subscription', client_reference_id: T, customer: `cus_${tag}`, subscription: `sub_${tag}` } } })
  const job = await S.createJob(db, T, { business_name: `Biz ${tag}`, industry: 'software', location: 'Toronto' }, null, now)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [now, job])
  await S.finishJob(db, { id: job, attempts: 1 }, { status: 'done', error: null, now: now + 5, leads: [
    { name: 'Pat', company: `SECRET-${tag}-CO`, contact: `pat@${tag}.example`, signal: 'Hiring', source_url: `https://${tag}.example/1`, score: 70, evidence_excerpt: `secret quote ${tag}`, event_date: '2026-10-01', date_status: 'verified', retrieved_at: now, confidence: 80, dedup_key: `${tag}1`, fit: 4, published_at: '2026-09-30', timing_note: `note ${tag}` },
  ] })
  const query = await S.createQueryJob(db, T, { query: `SECRET-${tag}-QUERY`, icp: null, runBudget: null }, now + 10)
  await runAudit(db, T, `${tag}-site.example`, { fetchImpl: stub, lookup, now, id: `audit-${tag}` })
  await db.run('INSERT INTO seo_briefs (id, tenant_id, topic, brief, created_at) VALUES (?, ?, ?, ?, ?)', [`brief-${tag}`, T, `SECRET-${tag}-TOPIC`, 'brief text', now])
  await db.run("INSERT INTO newsjacks (id, tenant_id, url, title, draft, status, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?)", [`news-${tag}`, T, `https://${tag}.example/n`, 't', `SECRET-${tag}-DRAFT`, now])
  await new DbQueue(db).enqueue({ id: `work-${tag}`, tenantId: T, kind: 'scan', now })
  await db.close()
  out({ session, job, query })
} else {
  const other = JSON.parse(process.env.ISO_OTHER!) as { session: string; job: string; query: string; tenant: string }
  const sent: string[] = []
  const stripeFetch = (async (u: string, init?: RequestInit) => { sent.push(`${u} ${String(init?.body)}`); return stub(u, init) }) as unknown as typeof fetch
  const q = new DbQueue(db)
  const r = {
    // with the other tenant's ids, as this tenant
    otherJob: await S.getJob(db, T, other.job) ?? null,
    otherLeads: await S.listLeads(db, T, other.job, 200, true),
    otherHidden: await S.countHiddenLeads(db, T, other.job),
    otherExport: await S.exportLeads(db, T, other.job, 5000, true),
    cancelOther: await S.cancelJob(db, T, other.query, now + 20),
    approveOtherNews: await approveNewsjack(db, T, `news-${other.tenant.slice(0, 1)}`),
    otherSessionAsMe: (await getSessionUser(other.session, db))?.id ?? null, // a token resolves only to its own tenant
    // this tenant's own lists and exports: everything returned
    jobs: await S.listJobs(db, T),
    exportAll: await S.exportLeads(db, T, undefined, 5000, true),
    latestJob: await S.latestJobId(db, T) ?? null,
    latestQuery: await S.latestQueryJob(db, T) ?? null,
    active: await S.countActiveJobs(db, T, now + 30),
    plan: await readPlan(db, T),
    login: (await findPasswordUser(`${tag}@example.test`, db))?.id ?? null,
    audits: await recentAudits(db, T),
    briefs: await recentBriefs(db, T),
    news: await recentNewsjacks(db, T),
    queueDepth: await q.depth({ tenantId: T }),
    claim: (await q.claim({ tenants: [T], now: now + 40 }))?.item.tenantId ?? null,
    portal: await createPortalUrl(db, T, stripeFetch),
    checkout: await createCheckoutUrl(db, T, `${tag}@example.test`, stripeFetch),
    stripeBodies: sent,
    rate: (await rateLimit(`scan:${T}`, 1, 3_600_000, db, now)).ok,
  }
  await db.close()
  out(r)
}
