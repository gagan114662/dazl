// One app instance for test/multi-instance-safety.test.ts: real route handlers and library code on the shared Postgres
// schema (MI_SCHEMA), its own pool, running at the same time as a second instance. After a start barrier it does, all at
// once: the same signed Stripe event delivered 8 times through /api/stripe; 15 failed sign-ins from one IP through
// /api/auth/signin (the per-IP limit is 20 per 15 min); drains the shared work queue, recording each job it processes;
// and 8 TinyFish searches under a server-wide limit of 6 a minute. It prints what it saw; the parent checks the totals.
// Stubbed: any network call throws, except the TinyFish stub, which counts calls and returns no hits.
import { NextRequest } from 'next/server'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pgDb, setDb } from '../../lib/db/client.ts'
import { DbQueue } from '../../lib/queue/db.ts'
import { tfSearch } from '../../lib/search/tinyfish.ts'

// test values from the parent under neutral names (the net fence drops *KEY*/*SECRET* variables)
Object.assign(process.env, { STRIPE_WEBHOOK_SECRET: process.env.MI_WEBHOOK, STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRICE_PRO: 'price_fixture', DB_PATH: '/nonexistent-dazl-dir/app.db' })
let tinyfishCalls = 0
globalThis.fetch = (async (u: unknown) => {
  if (String(u).startsWith('https://api.search.tinyfish.ai')) { tinyfishCalls++; await new Promise(r => setTimeout(r, 5)); return new Response(JSON.stringify({ results: [] }), { status: 200 }) }
  throw new Error(`Unexpected network call: ${String(u)}`)
}) as typeof fetch
const name = process.env.MI_NAME!
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.MI_SCHEMA, max: 6 })
setDb(db)
const stripe = await import('../../app/api/stripe/route.ts')
const signin = await import('../../app/api/auth/signin/route.ts')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const event = readFileSync(new URL('../fixtures/stripe/checkout.session.completed.json', import.meta.url), 'utf8')
  .replaceAll('{{TENANT}}', process.env.MI_TENANT!).replaceAll('{{CUSTOMER}}', 'cus_multi').replaceAll('{{SUBSCRIPTION}}', 'sub_multi')
  .replace(/"id": "evt_[^"]+"/, '"id": "evt_multiinstance0000000000001"')
const sign = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest('hex')}` }
const deliver = async () => (await (await stripe.POST(new NextRequest('https://dazl.test/api/stripe', { method: 'POST', body: event, headers: { 'content-type': 'application/json', 'stripe-signature': sign(event) } }))).json() as { result: string }).result
const failSignin = async (i: number) => (await signin.POST(new NextRequest('https://dazl.test/api/auth/signin', {
  method: 'POST', body: JSON.stringify({ email: `${name.toLowerCase()}${i}@example.test`, password: 'wrong-password' }),
  headers: { 'content-type': 'application/json', host: 'dazl.test', origin: 'https://dazl.test', 'x-forwarded-for': '203.0.113.77' } }))).status

// start barrier: both instances begin together
await db.run('INSERT INTO mi_ready (instance) VALUES (?)', [name])
while (Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM mi_ready'))!.n) < 2) await sleep(2)
const startedAt = Date.now()

const q = new DbQueue(db, { backoff: { baseSeconds: 0, jitter: 0 } })
const [webhook, signins, processed] = await Promise.all([
  Promise.all(Array.from({ length: 8 }, deliver)),
  (async () => { const s: number[] = []; for (let i = 0; i < 15; i++) s.push(await failSignin(i)); return s })(),
  (async () => {
    let n = 0
    for (;;) {
      const c = await q.claim({ kinds: ['mi-job'], maxInFlight: 100, perTenantInFlight: 100, leaseSeconds: 60 })
      if (!c) break
      await db.run('INSERT INTO mi_processed (job_id, instance) VALUES (?, ?)', [c.item.id, name])
      await sleep(3) // the job's work
      if (await q.complete(c.token)) n++
    }
    return n
  })(),
  (async () => { for (let i = 0; i < 8; i++) await tfSearch(db, process.env.MI_TENANT!, `query ${name} ${i}`, {}, { searches: 0 }, { env: { TINYFISH_API_KEY: 'tf-test', TINYFISH_PER_MINUTE: '6' } }) })(),
])
const finishedAt = Date.now()
await db.close()
process.stdout.write('\n' + JSON.stringify({ name, webhook, signins, processed, tinyfishCalls, startedAt, finishedAt }) + '\n')
