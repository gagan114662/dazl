// One app instance for test/concurrent-tenant-isolation.test.ts: the real route handlers on the shared Postgres schema
// (CT_SCHEMA), signed in as CT_TENANT, running at the same time as a second instance signed in as the other tenant.
// After a start barrier, each round it writes its own tenant's settings, connections, Cal.com secret and bookings, and
// Stripe events (signed webhook), reads them straight back, and tries the other tenant's ids, while the other instance
// does the same. Every read must return only its own tenant's values; every attempt on the other tenant must be refused
// or return nothing. Any violation is recorded and printed. The SQLite handle is a trap (DB_PATH cannot be opened,
// getScanDb() throws). Stubbed: no network call is allowed; Stripe events are fixtures signed with a test secret.
import { NextRequest } from 'next/server'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setUser } from './tenant-route-db.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db'
// test values from the parent (passed under neutral names: the net fence drops *KEY*/*SECRET* variables)
Object.assign(process.env, { STRIPE_WEBHOOK_SECRET: process.env.CT_WEBHOOK, DAZL_MASTER_KEY: process.env.CT_MASTER, STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_PRO: 'price_fixture' })
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${String(u)}`) }) as typeof fetch
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.CT_SCHEMA, max: 3 })
setDb(db)
const me = process.env.CT_TENANT!, tag = process.env.CT_TAG!, rounds = Number(process.env.CT_ROUNDS ?? 6)
const other = JSON.parse(process.env.CT_OTHER!) as { tenant: string; tag: string; lead: string }
const myLead = process.env.CT_LEAD!
setUser({ id: me, business_name: `Co ${tag}`, email: `${tag}@example.test` } as never)

const memory = await import('../../app/api/settings/memory/route.ts')
const competitors = await import('../../app/api/settings/competitors/route.ts')
const warm = await import('../../app/api/warm/connections/route.ts')
const warmPath = await import('../../app/api/leads/[lead]/warm-path/route.ts')
const calcom = await import('../../app/api/settings/calcom/route.ts')
const hook = await import('../../app/api/hooks/calcom/route.ts')
const enrichment = await import('../../app/api/settings/enrichment/route.ts')
const stripe = await import('../../app/api/stripe/route.ts')
const usage = await import('../../app/api/usage/route.ts')

const req = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': '203.0.113.5', ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = <T extends object>(p: T) => ({ params: Promise.resolve(p) })
const json = async (r: Response | Promise<Response>) => { const x = await r; return { status: x.status, body: await x.json() as Record<string, unknown> } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const signStripe = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}` }
const stripeEvent = (name: string, id: string, created: number) => readFileSync(new URL(`../fixtures/stripe/${name}.json`, import.meta.url), 'utf8')
  .replaceAll('{{TENANT}}', me).replaceAll('{{CUSTOMER}}', `cus_${tag}`).replaceAll('{{SUBSCRIPTION}}', `sub_${tag}`)
  .replace(/"id": "evt_[^"]+"/, `"id": "${id}"`).replace(/"created": \d+/, `"created": ${created}`)

const violations: string[] = []
const expect = (ok: boolean, what: string) => { if (!ok) violations.push(what) }
const mentionsOther = (v: unknown) => JSON.stringify(v).includes(other.tag) || JSON.stringify(v).includes(other.tenant)

// start barrier: both instances run their rounds at the same time
await db.run('INSERT INTO ct_ready (instance) VALUES (?)', [tag])
while (Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM ct_ready'))!.n) < 2) await sleep(5)

let calcomSecret = ''
const startedAt = Date.now()
for (let r = 0; r < rounds; r++) {
  // settings: memory and competitors, read straight back
  const m = await json(memory.PUT(req('/api/settings/memory', 'PUT', { icp: `${tag} icp ${r}`, positioning: `${tag} pos`, exclusions: [`${tag}-excluded-${r}`] })))
  expect(m.status === 200, `memory save ${r}: ${m.status}`)
  const mr = await json(memory.GET())
  expect((mr.body.memory as { icp?: string })?.icp === `${tag} icp ${r}` && !mentionsOther(mr.body), `memory read ${r}: ${JSON.stringify(mr.body)}`)
  await json(competitors.PUT(req('/api/settings/competitors', 'PUT', { competitors: [`${tag} Rival ${r}`] })))
  const cr = await json(competitors.GET())
  expect(JSON.stringify(cr.body.competitors) === JSON.stringify([`${tag} Rival ${r}`]), `competitors read ${r}: ${JSON.stringify(cr.body)}`)

  // LinkedIn connections import (replace), status, and this tenant's warm paths; the other tenant's lead gives nothing
  const csv = `First Name,Last Name,URL\n${tag},Contact${r},https://www.linkedin.com/in/${tag}-contact-${r}\n${tag},Second${r},https://www.linkedin.com/in/${tag}-second-${r}\n`
  const imp = await json(warm.POST(req('/api/warm/connections', 'POST', { csv, confirm_replace: true })))
  expect(imp.status === 200 && imp.body.imported === 2, `warm import ${r}: ${JSON.stringify(imp)}`)
  const st = await json(warm.GET())
  expect(st.body.count === 2, `warm status ${r}: ${JSON.stringify(st.body)}`)
  const own = await json(warmPath.GET(req(`/api/leads/${myLead}/warm-path`), ctx({ lead: myLead })))
  expect(own.status === 200 && !mentionsOther(own.body), `own warm path ${r}: ${JSON.stringify(own.body)}`)
  const theirs = await json(warmPath.GET(req(`/api/leads/${other.lead}/warm-path`), ctx({ lead: other.lead })))
  expect(!mentionsOther(theirs.body) && (theirs.body.first_degree as unknown[] ?? []).length === 0 && (theirs.body.user_reported as unknown[] ?? []).length === 0, `other tenant's warm path ${r}: ${JSON.stringify(theirs.body)}`)
  const report = await json(warmPath.POST(req(`/api/leads/${other.lead}/warm-path`, 'POST', { contact_url: `https://www.linkedin.com/in/${tag}-intruder`, mutual_name: `${tag} Mutual` }), ctx({ lead: other.lead })))
  expect(report.status >= 400, `report on other tenant's lead ${r}: ${report.status}`)

  // Cal.com: rotate this tenant's secret, deliver a booking signed with it; the same signature for the other tenant fails
  const rot = await json(calcom.POST(req('/api/settings/calcom', 'POST', { action: 'rotate' })))
  calcomSecret = String(rot.body.secret)
  const raw = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { uid: `${tag}-bk-${r}`, attendees: [{ email: `${tag}-${r}@example.test`, name: tag }] } })
  const sig = createHmac('sha256', calcomSecret).update(raw).digest('hex')
  const okHook = await json(hook.POST(req(`/api/hooks/calcom?u=${me}`, 'POST', raw, { 'x-cal-signature-256': sig })))
  expect(okHook.status === 200 && okHook.body.ok === true, `own booking ${r}: ${JSON.stringify(okHook)}`)
  const badHook = await hook.POST(req(`/api/hooks/calcom?u=${other.tenant}`, 'POST', raw, { 'x-cal-signature-256': sig }))
  expect(badHook.status === 401 || badHook.status === 404, `booking into other tenant with own secret ${r}: ${badHook.status}`)
  const cal = await json(calcom.GET(req('/api/settings/calcom')))
  expect(cal.body.secret === calcomSecret && !mentionsOther(cal.body), `calcom read ${r}: ${JSON.stringify(cal.body).slice(0, 300)}`)

  // enrichment key: save, then the status lists only this tenant's connectors
  await json(enrichment.POST(req('/api/settings/enrichment', 'POST', { connector: 'enrich:apollo', key: `${tag}-apollo-key-000${r}` })))
  const en = await json(enrichment.GET())
  expect((en.body.connectors as { last4: string }[]).every(c => c.last4 === `000${r}`.slice(-4)) && !mentionsOther(en.body), `enrichment read ${r}: ${JSON.stringify(en.body)}`)

  // Stripe: round 0 checkout -> Pro; round 2 payment failed -> past_due; last round deleted -> Free
  const created = 1793000000 + r * 10
  const evt = r === 0 ? stripeEvent('checkout.session.completed', `evt${tag}co`, created)
    : r === 2 ? stripeEvent('invoice.payment_failed', `evt${tag}pf`, created)
    : r === rounds - 1 ? stripeEvent('customer.subscription.deleted', `evt${tag}del`, created) : null
  if (evt) {
    const w = await json(stripe.POST(req('/api/stripe', 'POST', evt, { 'stripe-signature': signStripe(evt) })))
    expect(w.status === 200 && w.body.result === 'applied', `stripe ${r}: ${JSON.stringify(w)}`)
  }
  const u = await json(usage.GET(req('/api/usage')))
  const want = r === rounds - 1 ? ['free', 'canceled'] : r >= 2 ? ['pro', 'past_due'] : ['pro', 'active']
  expect(u.body.plan === want[0] && u.body.billing_status === want[1], `plan after round ${r}: ${JSON.stringify(u.body)}`)
}
const finishedAt = Date.now()
await db.close()
process.stdout.write('\n' + JSON.stringify({ tag, rounds, violations, calcomSecret, startedAt, finishedAt }) + '\n')
