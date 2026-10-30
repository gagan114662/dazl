// #192 reworked: LinkedIn people signals through an INJECTED transport only. Invented profiles; no network, no session, no LinkedIn call. Both engines for the Db-layer behaviour.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { collectLinkedInPeople, linkedinQueries, gatesOpen, profileKey, MAX_ITEMS, MAX_REQUESTS_PER_HOUR, MAX_REQUESTS_PER_RUN, COOLDOWN_S, type LinkedInTransport, type TransportRequest, type TransportResult } from '../lib/signals/linkedin-people.ts'
import { writeConsent } from '../lib/advanced/index.ts'
import { setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { writeAudit } from '../lib/connectors/store.ts'
import { collectAdvanced } from '../lib/advanced/index.ts'
import { requestsInWindow, reserveRequest } from '../lib/advanced/request-budget.ts'
import { pgDb } from '../lib/db/client.ts'
import type { Db } from '../lib/db/client.ts'

const ICP = { who: ['HR manager'], where: ['Ohio'], industries: ['SaaS'] }
const ENV = { ADVANCED_CONNECTORS: '1', ADVANCED_LINKEDIN: '1', ADVANCED_LINKEDIN_PEOPLE: '1' }
const ADV_ENV = { ...ENV, ADVANCED_WORKER_URL: 'http://w', ADVANCED_WORKER_TOKEN: 't' }   // the existing advanced post search also needs its worker settings
const NOW = Math.floor(Date.now() / 1000)   // audit rows are stamped by the database clock
const person = (id: string) => ({ url: `https://www.linkedin.com/in/${id}/`, title: id, quote: `${id} comments on a competitor post`, date: '2026-10-20' })
const ok = (...ids: string[]): TransportResult => ({ status: 'ok', items: ids.map(person) })
function recorder(answers: TransportResult[]) { const seen: TransportRequest[] = []; const t: LinkedInTransport = { fetch: async r => { seen.push(r); return answers[Math.min(seen.length - 1, answers.length - 1)] } }; return { t, seen } }
async function ready(db: Db, tenant = 'A') { await writeConsent(db, tenant, 'linkedin'); await setCompetitors(db, tenant, ['Rippling', 'Gusto']) }
const audits = async (db: Db, tenant = 'A') => (await db.all<{ connector: string; status: string; lookup: string }>('SELECT connector, status, lookup FROM connector_audit WHERE tenant_id = ? ORDER BY insert_seq', [tenant])).map(a => `${a.connector.replace('adv:', '')}:${a.status}`)

test('queries: one people search first, then competitor engagers, within the budget', () => {
  assert.deepEqual(linkedinQueries(ICP, ['Rippling', 'Gusto'], 3), [{ kind: 'people', query: 'HR manager Ohio' }, { kind: 'engagers', query: 'Rippling' }, { kind: 'engagers', query: 'Gusto' }])
  assert.deepEqual(linkedinQueries(ICP, ['Rippling'], 1), [{ kind: 'people', query: 'HR manager Ohio' }])
  assert.deepEqual(linkedinQueries({ ...ICP, who: [] }, ['Rippling'], 3), [{ kind: 'engagers', query: 'Rippling' }])
  assert.deepEqual(linkedinQueries(ICP, ['Rippling'], 0), [])
})

bothEngines('OFF by default: the flag, the people flag, the tenant\'s consent and a transport are ALL required; otherwise nothing is requested', async ({ db }) => {
  await ready(db); const { t, seen } = recorder([ok('alice-a')])
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: {} }), [])
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: { ADVANCED_CONNECTORS: '1', ADVANCED_LINKEDIN: '1' } }), [], 'the platform flags alone do not enable the people reader')
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: { ...ENV, ADVANCED_KILL: '1' } }), [], 'the advanced kill switch still applies')
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: NOW }).then(r => r.length > 0), true, 'control: everything on')
  const n = seen.length
  assert.deepEqual(await collectLinkedInPeople(db, 'B', 'j', ICP, { transport: t, env: ENV }), [], 'a tenant without consent'); assert.equal(seen.length, n)
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j2', ICP, { env: ENV, now: NOW + 7200 }), [], 'no transport = unavailable'); assert.equal(seen.length, n)
  const a = await audits(db); assert.ok(a.includes('linkedin-people:disabled') && a.includes('linkedin-people:unavailable'), JSON.stringify(a)); assert.deepEqual(await audits(db, 'B'), ['linkedin-people:no_consent'])
})

bothEngines('no session is read or needed, and nothing outside a public profile URL is accepted; items and text are bounded; requests carry the tenant', async ({ db }) => {
  await ready(db)
  const many = Array.from({ length: 60 }, (_, i) => person(`p${i}`)); const junk = [{ url: 'https://evil.example/in/x', title: 't', quote: 'q', date: null }, { url: 'https://www.linkedin.com/feed/', title: 't', quote: 'q', date: null }, { url: 'javascript:alert(1)', title: 't', quote: 'q', date: null }, { ...person('long'), quote: 'x'.repeat(2000), title: 'y'.repeat(500) }]
  const { t, seen } = recorder([{ status: 'ok', items: [...junk, ...many] }])
  const r = await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: NOW })
  assert.ok(r.length <= MAX_REQUESTS_PER_RUN * MAX_ITEMS); assert.ok(r.every(i => /^https:\/\/www\.linkedin\.com\/in\//.test(i.url) && i.login_walled))
  assert.ok(r.every(i => (i.quote?.length ?? 0) <= 300 && (i.title?.length ?? 0) <= 120)); assert.ok(seen.every(q => q.tenantId === 'A' && q.maxItems === MAX_ITEMS && q.signal instanceof AbortSignal))
  assert.equal(await db.get('SELECT 1 AS x FROM tenant_connectors WHERE connector = ?', ['adv:linkedin']), undefined, 'no member session is stored or required')
})

bothEngines('per-request budgets: at most MAX_REQUESTS_PER_RUN per scan and MAX_REQUESTS_PER_HOUR per tenant per hour', async ({ db }) => {
  await ready(db); const { t, seen } = recorder([ok('alice-a')])
  await collectLinkedInPeople(db, 'A', 'j1', ICP, { transport: t, env: ENV, now: NOW }); assert.equal(seen.length, MAX_REQUESTS_PER_RUN)
  await collectLinkedInPeople(db, 'A', 'j2', ICP, { transport: t, env: ENV, now: NOW }); assert.equal(seen.length, MAX_REQUESTS_PER_HOUR, 'only the remaining hourly request is made')
  await collectLinkedInPeople(db, 'A', 'j3', ICP, { transport: t, env: ENV, now: NOW }); assert.equal(seen.length, MAX_REQUESTS_PER_HOUR); assert.ok((await audits(db)).includes('linkedin-people:rate_limited'))
})

bothEngines('NEGATIVE: throttling, a challenge or an unauthorised answer STOPS the run at once (no retry, no second request) and starts a cooldown for that tenant only', async ({ db }) => {
  for (const status of ['throttled', 'challenge', 'unauthorized'] as const) {
    const tenant = `T-${status}`, other = `O-${status}`; await ready(db, tenant); await ready(db, other)
    const { t, seen } = recorder([{ status }, ok('never-asked')])
    assert.deepEqual(await collectLinkedInPeople(db, tenant, 'j', ICP, { transport: t, env: ENV, now: NOW }), []); assert.equal(seen.length, 1, `${status}: one request, then stop`)
    assert.ok((await audits(db, tenant)).includes(`linkedin:stopped_${status}`))
    const stoppedAt = Number((await db.get<{ at: number }>("SELECT MAX(created_at) AS at FROM connector_audit WHERE tenant_id = ? AND status LIKE 'stopped_%'", [tenant]))!.at)   // the database clock, so the test does not depend on how long it took to get here
    assert.deepEqual(await collectLinkedInPeople(db, tenant, 'j2', ICP, { transport: t, env: ENV, now: stoppedAt + COOLDOWN_S - 10 }), []); assert.equal(seen.length, 1, 'still cooling down: nothing requested')
    assert.ok((await audits(db, tenant)).includes('linkedin-people:cooldown'))
    const o = recorder([ok('bob-b')]); assert.ok((await collectLinkedInPeople(db, other, 'j', ICP, { transport: o.t, env: ENV, now: NOW })).length > 0, 'another tenant is unaffected'); assert.ok(o.seen.length > 0)
    const after = recorder([ok('carol-c')]); assert.ok((await collectLinkedInPeople(db, tenant, 'j3', ICP, { transport: after.t, env: ENV, now: stoppedAt + COOLDOWN_S + 5 })).length > 0, 'cooldown ends')
  }
})

bothEngines('a transport error or a throw is an error (audited, not retried); the next query still runs and a thrown error never escapes', async ({ db }) => {
  await ready(db)
  const seen: string[] = []; const t: LinkedInTransport = { fetch: async r => { seen.push(r.kind); if (r.kind === 'people') throw new Error('boom'); return ok('xavier-x') } }
  const r = await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: NOW })
  assert.deepEqual(seen, ['people', 'engagers']); assert.equal(r.length, 1); assert.ok((await audits(db)).includes('linkedin:error'))
})

bothEngines('another tenant\'s earlier requests never count against this tenant\'s hourly budget', async ({ db }) => {
  await ready(db, 'A'); await ready(db, 'B')
  for (let i = 0; i < 5; i++) await reserveRequest(db, 'B', 'adv:linkedin', 99, 'other', Math.floor(Date.now() / 1000))
  const { t, seen } = recorder([ok('alice-a')]); await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: Math.floor(Date.now() / 1000) }); assert.equal(seen.length, MAX_REQUESTS_PER_RUN)
})


// ---- Instinct's four failing controls on 14ccc7f (each fails on that head) ----
const advWorker = (seen: string[]) => async (r: { query: string }) => { seen.push(`worker:${r.query}`); return [] as never[] }

bothEngines('CONTROL 1: concurrent consumers with 2 of 3 hourly requests already used make exactly ONE more upstream request in total (never 4 against the 3/hour limit)', async ({ db, kind, url, schema }) => {
  await ready(db)
  const nowS = Math.floor(Date.now() / 1000)
  assert.equal(await reserveRequest(db, 'A', 'adv:linkedin', 3, 'seed', nowS), true); assert.equal(await reserveRequest(db, 'A', 'adv:linkedin', 3, 'seed', nowS), true)
  const seen: string[] = []
  const t: LinkedInTransport = { fetch: async r => { seen.push(`people:${r.kind}`); await new Promise(res => setTimeout(res, 15)); return ok(`p-${seen.length}-x`) } }
  // separate pools on Postgres = separate workers/instances; one SQLite connection otherwise
  const pools: Db[] = kind === 'pg' ? [0, 1, 2].map(() => pgDb({ connectionString: url!, searchPath: schema, max: 1 })) : [db, db, db]
  try {
    await Promise.all([
      collectLinkedInPeople(pools[0], 'A', 'j1', ICP, { transport: t, env: ADV_ENV, now: nowS }),
      collectLinkedInPeople(pools[1], 'A', 'j2', ICP, { transport: t, env: ADV_ENV, now: nowS }),
      collectAdvanced(pools[2], 'A', 'j3', ['linkedin'], 'payroll help', { worker: advWorker(seen), env: ADV_ENV, now: nowS }),
    ])
    assert.equal(seen.length, 1, `exactly 1 more upstream request, got ${seen.length}: ${seen.join(', ')}`)
    assert.equal(await requestsInWindow(db, 'A', 'adv:linkedin', nowS), 3, 'the window holds 3 reservations, never 4')
  } finally { if (kind === 'pg') await Promise.all(pools.map(p => p.close())) }
})

bothEngines('CONTROL 2: the same profile returned by several queries (or twice in one answer, in any URL spelling) is ONE lead', async ({ db }) => {
  await ready(db)
  const dup = (id: string) => [person(id), { ...person(id), url: `https://www.linkedin.com/in/${id.toUpperCase()}` }, { ...person(id), url: `https://www.linkedin.com/in/${id}/?trk=abc` }]
  const t: LinkedInTransport = { fetch: async () => ({ status: 'ok', items: [...dup('jane-doe-1'), person('bob-roe-2')] }) }
  const r = await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: Math.floor(Date.now() / 1000) })
  assert.deepEqual(r.map(i => profileKey(i.url)).sort(), ['https://www.linkedin.com/in/bob-roe-2', 'https://www.linkedin.com/in/jane-doe-1'])
  assert.equal(r.length, 2, 'two queries each returned both profiles; each appears once')
})

bothEngines('CONTROL 3: every kill gate stops it - environment switches, kill switch, consent, the tenant\'s connector switch - before the first request AND mid-run', async ({ db }) => {
  await ready(db); const calls: number[] = []; const t: LinkedInTransport = { fetch: async () => { calls.push(1); return ok(`p${calls.length}-x`) } }
  const nowS = Math.floor(Date.now() / 1000)
  for (const [label, env] of [['no ADVANCED_CONNECTORS', { ...ENV, ADVANCED_CONNECTORS: undefined }], ['ADVANCED_KILL=1', { ...ENV, ADVANCED_KILL: '1' }], ['ADVANCED_LINKEDIN off', { ...ENV, ADVANCED_LINKEDIN: '0' }], ['people flag off', { ...ENV, ADVANCED_LINKEDIN_PEOPLE: undefined }]] as [string, Record<string, string | undefined>][]) {
    assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env, now: nowS }), [], label); assert.equal(calls.length, 0, label); assert.equal(gatesOpen(env), false, label)
  }
  assert.equal(await collectLinkedInPeople(db, 'NOCONSENT', 'j', ICP, { transport: t, env: ENV, now: nowS }).then(r => r.length), 0); assert.equal(calls.length, 0)
  await db.run("INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, 'x', '0000', 0)", ['A', 'adv:linkedin'])   // the tenant's own switch for the connector, off
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: t, env: ENV, now: nowS }), [], 'the tenant switched the connector off'); assert.equal(calls.length, 0)
  await db.run('UPDATE tenant_connectors SET enabled = 1 WHERE tenant_id = ? AND connector = ?', ['A', 'adv:linkedin'])
  // mid-run: the kill switch is thrown after the first request
  const env = { ...ENV } as Record<string, string | undefined>; const killing: LinkedInTransport = { fetch: async () => { calls.push(1); env.ADVANCED_KILL = '1'; return ok('first-one') } }
  const before = calls.length; await collectLinkedInPeople(db, 'A', 'j2', ICP, { transport: killing, env, now: nowS + 7200 })
  assert.equal(calls.length - before, 1, 'the second request never happens once the kill switch is on')
  env.ADVANCED_KILL = undefined; const c = await collectLinkedInPeople(db, 'A', 'j3', ICP, { transport: t, env: ENV, now: nowS + 14400 }); assert.ok(c.length > 0, 'control: all gates open')
})

bothEngines('CONTROL 4: a transport that ignores the abort cannot hold the run, and its late result is DISCARDED after the deadline', async ({ db }) => {
  await ready(db); let aborted = false
  const late: LinkedInTransport = { fetch: async r => { r.signal.addEventListener('abort', () => { aborted = true }); await new Promise(res => setTimeout(res, 150)); return ok('late-person') } }   // ignores the abort
  const t0 = Date.now(); const r = await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: late, env: ENV, now: Math.floor(Date.now() / 1000), deadlineMs: 30 })
  assert.deepEqual(r, [], 'a result that arrives after the deadline is not accepted'); assert.equal(aborted, true, 'the abort signal was raised')
  assert.ok(Date.now() - t0 < 140 * 2 + 100, 'the run did not wait for the ignored-abort transport'); assert.ok((await audits(db)).includes('linkedin:error'))
  const fast: LinkedInTransport = { fetch: async () => ok('on-time-person') }
  assert.ok((await collectLinkedInPeople(db, 'A', 'j2', ICP, { transport: fast, env: ENV, now: Math.floor(Date.now() / 1000) + 7200, deadlineMs: 500 })).length > 0, 'control: an on-time answer is accepted')
})

bothEngines('CONTRACT: one transport call is exactly one upstream request - a call reporting more (pagination / fan-out) is discarded and stops the run', async ({ db }) => {
  await ready(db); let calls = 0
  const paging: LinkedInTransport = { fetch: async () => { calls++; return { status: 'ok', items: [person('paged-one'), person('paged-two')], upstream_requests: 3 } } }
  assert.deepEqual(await collectLinkedInPeople(db, 'A', 'j', ICP, { transport: paging, env: ENV, now: Math.floor(Date.now() / 1000) }), []); assert.equal(calls, 1)
  assert.ok((await audits(db)).includes('linkedin:stopped_contract'))
})


// ---- upgrade controls: usage recorded BEFORE reservations existed still counts, and a new request is never counted twice ----
const legacyAudit = async (db: Db, tenant: string, n: number, agoS: number, status = 'ok') => { const now = Math.floor(Date.now() / 1000); for (let i = 0; i < n; i++) await db.run("INSERT INTO connector_audit (id, tenant_id, connector, lookup, status, results, created_at) VALUES (?, ?, 'adv:linkedin', 'x', ?, 0, ?)", [`legacy-${tenant}-${i}-${agoS}-${status}`, tenant, status, now - agoS]) }

bothEngines('UPGRADE (non-empty): 2 calls made before the upgrade (audit rows, no reservations) leave exactly 1 request for concurrent consumers; older calls and other tenants do not count', async ({ db }) => {
  await ready(db); await ready(db, 'B')
  await legacyAudit(db, 'A', 2, 600); await legacyAudit(db, 'A', 5, 7200); await legacyAudit(db, 'B', 9, 60)       // A: 2 in the hour, 5 two hours ago; B: another tenant
  const nowS = Math.floor(Date.now() / 1000), seen: string[] = []
  const t: LinkedInTransport = { fetch: async r => { seen.push(r.kind); await new Promise(res => setTimeout(res, 10)); return ok(`up-${seen.length}-x`) } }
  await Promise.all([collectLinkedInPeople(db, 'A', 'j1', ICP, { transport: t, env: ADV_ENV, now: nowS }), collectLinkedInPeople(db, 'A', 'j2', ICP, { transport: t, env: ADV_ENV, now: nowS }), collectAdvanced(db, 'A', 'j3', ['linkedin'], 'payroll', { worker: advWorker(seen), env: ADV_ENV, now: nowS })])
  assert.equal(seen.length, 1, `2 of 3 were used before the upgrade, so exactly 1 more is allowed; got ${seen.length}`)
  assert.equal((await collectLinkedInPeople(db, 'B', 'jB', ICP, { transport: recorder([ok('bob-b')]).t, env: ADV_ENV, now: nowS })).length, 0, 'tenant B used 9 in the hour: rate limited, and A\'s history is not B\'s')
})

bothEngines('NO DOUBLE COUNT: a new request is a reservation AND an audit row, and counts once; three new requests use exactly the budget of 3', async ({ db }) => {
  await ready(db); const nowS = Math.floor(Date.now() / 1000), seen: string[] = []
  const t: LinkedInTransport = { fetch: async r => { seen.push(r.kind); return ok(`once-${seen.length}-x`) } }
  await collectLinkedInPeople(db, 'A', 'j1', ICP, { transport: t, env: ADV_ENV, now: nowS })          // 2 requests: reservation + audit row each
  assert.equal(seen.length, 2); assert.equal(await requestsInWindow(db, 'A', 'adv:linkedin', nowS), 2)
  const used = Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connector_audit WHERE tenant_id = 'A' AND connector = 'adv:linkedin' AND status IN ('ok','empty','worker_error','error')"))!.n); assert.equal(used, 2, 'two audit rows too - and the budget still reads 2, not 4')
  await collectLinkedInPeople(db, 'A', 'j2', ICP, { transport: t, env: ADV_ENV, now: nowS + 1 })      // 1 request left
  assert.equal(seen.length, 3, 'the third request is allowed (2 + 1 = 3, not 4 + 1)')
  await collectLinkedInPeople(db, 'A', 'j3', ICP, { transport: t, env: ADV_ENV, now: nowS + 2 }); assert.equal(seen.length, 3, 'then rate limited')
})
