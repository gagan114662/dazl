// #365 (narrow patch): a CRM push is reported as done only when the CRM's answer names the record it created or the
// lead's own existing record. An answer that may hide a created record is 'unknown' and blocks a blind retry; a definite
// refusal is 'failed'. The generic webhook keeps its own protocol (any 2xx, 204 included, with no record id). Isolated
// mocks only: no CRM request leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { claimPush, CrmPushError, crmDestination, finishClaim, pushLead, resolveClaim, STALE_CLAIM_SECONDS, type CrmConfig, type CrmLead } from '../lib/crm/index.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'

const LEAD = { company: 'Synthetic Co', name: 'Pat Example', contact: 'pat@synthetic.example', signal: 's', source_url: 'https://news.example/a' }
const HS: CrmConfig = { provider: 'hubspot', key: 'synthetic' }, PD: CrmConfig = { provider: 'pipedrive', key: 'synthetic' }
const res = (body: string | null, status = 200) => async () => new Response(body, { status })
const json = (v: unknown, status = 200) => res(JSON.stringify(v), status)
async function outcome(cfg: CrmConfig, f: (u: string) => Promise<Response>, lead: CrmLead = LEAD): Promise<string> {
  try { const r = await pushLead(cfg, lead, f as never); return `ok:${r.externalId}` } catch (e) { return e instanceof CrmPushError ? e.outcome : `plain:${(e as Error).message}` }
}

test('HubSpot: success needs a decimal-string contact id; anything else after a 2xx or a 5xx is unknown; a 4xx is failed', async () => {
  assert.equal(await outcome(HS, json({ id: '1234' }, 201)), 'ok:1234')
  for (const [why, f] of [['empty {}', json({})], ['empty body', res('')], ['malformed JSON', res('{"id": ')], ['null', res('null')], ['array', json([{ id: '1' }])],
    ['numeric id', json({ id: 1234 })], ['empty id', json({ id: '' })], ['non-decimal id', json({ id: 'abc' })], ['object id', json({ id: { v: '1' } })],
    ['500', json({ id: '1' }, 500)], ['503 empty', res('', 503)]] as const)
    assert.equal(await outcome(HS, f), 'unknown', why)
  for (const s of [400, 401, 403, 429]) assert.equal(await outcome(HS, json({ message: 'no' }, s)), 'failed', String(s))
})

test('HubSpot 409: "already there" only when the named contact has the lead\'s email; any other conflict is a refusal', async () => {
  const conflict = (existing: Response | null, msg = 'Contact already exists. Existing ID: 77') => async (u: RequestInfo | URL) => {
    if (String(u).endsWith('/contacts')) return new Response(JSON.stringify({ status: 'error', message: msg, category: 'CONFLICT' }), { status: 409 })
    assert.match(String(u), /\/contacts\/77\?properties=email$/)
    if (!existing) throw new TypeError('fetch failed')
    return existing
  }
  const contact = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
  assert.equal(await outcome(HS, conflict(contact({ id: '77', properties: { email: 'Pat@Synthetic.example' } }))), 'ok:77')
  for (const [why, f] of [
    ['another person\'s contact', conflict(contact({ id: '77', properties: { email: 'someone@else.example' } }))],
    ['no Existing ID', conflict(contact({ id: '77', properties: { email: LEAD.contact } }), 'Conflict')],
    ['lookup returns another id', conflict(contact({ id: '78', properties: { email: LEAD.contact } }))],
    ['lookup without email', conflict(contact({ id: '77', properties: {} }))],
    ['lookup malformed', conflict(new Response('nope', { status: 200 }))],
    ['lookup 404', conflict(new Response('{}', { status: 404 }))],
    ['lookup network error', conflict(null)],
  ] as const) assert.equal(await outcome(HS, f as never), 'failed', why)
  // a lead with no email cannot be matched to a conflicting contact
  assert.equal(await outcome(HS, conflict(contact({ id: '77', properties: { email: '' } })) as never, { ...LEAD, contact: null }), 'failed')
})

test('Pipedrive: success needs success:true and a positive integer person id; an explicit success:false is failed', async () => {
  assert.equal(await outcome(PD, json({ success: true, data: { id: 5 } }, 201)), 'ok:5')
  for (const [why, f] of [['empty {}', json({})], ['empty body', res('')], ['malformed', res('{')], ['null', res('null')], ['success without data', json({ success: true })],
    ['string id', json({ success: true, data: { id: '5' } })], ['zero id', json({ success: true, data: { id: 0 } })], ['fractional id', json({ success: true, data: { id: 1.5 } })],
    ['no success flag', json({ data: { id: 5 } })], ['500', json({ success: true, data: { id: 5 } }, 500)]] as const)
    assert.equal(await outcome(PD, f), 'unknown', why)
  assert.equal(await outcome(PD, json({ success: false, error: 'bad' })), 'failed')
  for (const s of [400, 401, 403, 429]) assert.equal(await outcome(PD, json({ success: false }, s)), 'failed', String(s))
})

test('a thrown fetch is unknown, unless it says no connection was made', async () => {
  const thrown = (cause?: { code: string }) => async () => { throw Object.assign(new TypeError('fetch failed'), cause ? { cause } : {}) }
  for (const cfg of [HS, PD]) {
    assert.equal(await outcome(cfg, async () => { throw new DOMException('timed out', 'TimeoutError') }), 'unknown')
    assert.equal(await outcome(cfg, thrown({ code: 'ECONNRESET' })), 'unknown')
    assert.equal(await outcome(cfg, thrown()), 'unknown')
    assert.equal(await outcome(cfg, thrown({ code: 'ECONNREFUSED' })), 'failed')
    assert.equal(await outcome(cfg, thrown({ code: 'ENOTFOUND' })), 'failed')
  }
})

test('generic webhook keeps its own protocol: 204 with no body is delivery, no record id expected', async () => {
  const lookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const hook = (f: () => Promise<Response>) => pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, LEAD, f as never, { lookup })
  assert.deepEqual(await hook(res(null, 204)), { message: 'Lead sent to your webhook', externalId: null })
  assert.deepEqual(await hook(res('', 200)), { message: 'Lead sent to your webhook', externalId: null })
  await assert.rejects(() => hook(res('x', 500)), (e: Error) => !(e instanceof CrmPushError) && /Webhook 500/.test(e.message))
})

// The real /api/crm route, a real SQLite file and two tenants, in a child process (DB_PATH and the module loader).
test('route: truthful outcomes, audit rows, unknown blocks a blind retry until resolved, tenant-scoped', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs',
    '--test', './test/helpers/crm-route-runtime.mts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 9\b/)
  assert.match(r.stdout, /# fail 0\b/)
})

// Two workers (two connections to one database file) claiming the same push: exactly one wins, every time.
test('claims across two workers: one winner; resolution races change one row once; an old attempt never finishes a newer claim', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'dazl-claims-')), 'app.db')
  const w1 = new Database(file); migrateConnectors(w1); const w2 = new Database(file)
  const dest = crmDestination(HS), NOW = 1_800_000_000
  const won = (cs: ReturnType<typeof claimPush>[]) => cs.filter(c => 'attemptId' in c) as { attemptId: string }[]
  for (let i = 0; i < 20; i++) {
    const lead = `lead-${i}`
    const cs = [claimPush(w1, 'A', dest, lead, NOW), claimPush(w2, 'A', dest, lead, NOW)]
    assert.equal(won(cs).length, 1, lead)
    assert.deepEqual(cs.find(c => 'blocked' in c), { blocked: 'in_progress' })
  }
  // the winner records unknown; two resolves race: one changes the row, the other finds nothing to resolve
  const first = won([claimPush(w1, 'A', dest, 'lead-x', NOW)])[0]
  assert.ok(finishClaim(w1, 'A', dest, 'lead-x', first.attemptId, 'uncertain', null, NOW))
  assert.deepEqual([resolveClaim(w1, 'A', dest, 'lead-x', false, NOW), resolveClaim(w2, 'A', dest, 'lead-x', true, NOW)], [true, false])
  // after "not created" exactly one worker claims again, IN THE SAME SECOND as the first attempt
  const second = won([claimPush(w1, 'A', dest, 'lead-x', NOW), claimPush(w2, 'A', dest, 'lead-x', NOW)])
  assert.equal(second.length, 1)
  // the first attempt (same second, older) can never finish the newer claim; the newer one can
  assert.equal(finishClaim(w2, 'A', dest, 'lead-x', first.attemptId, 'ok', '1', NOW), false)
  assert.ok(finishClaim(w2, 'A', dest, 'lead-x', second[0].attemptId, 'ok', '2', NOW))
  // a stale claim resolved meanwhile cannot be finished by its late request
  const late = won([claimPush(w1, 'A', dest, 'lead-y', NOW)])[0]
  assert.ok(resolveClaim(w2, 'A', dest, 'lead-y', true, NOW + STALE_CLAIM_SECONDS))
  assert.equal(finishClaim(w1, 'A', dest, 'lead-y', late.attemptId, 'ok', '9', NOW + STALE_CLAIM_SECONDS + 1), false)
  w1.close(); w2.close()
})

// Instinct's HOLD on 8e8ef6e: a key is a credential, not an account identity. The hold is provider-scoped.
test('a rotated or replaced key never lifts an unresolved claim; another provider is a separate destination; tenants are separate', () => {
  const db = new Database(':memory:'); migrateConnectors(db)
  const NOW = 1_800_000_000
  const before = { provider: 'hubspot', key: 'token-before' } as CrmConfig, after = { provider: 'hubspot', key: 'token-after' } as CrmConfig
  const c = claimPush(db, 't', crmDestination(before), 'l', NOW)
  assert.ok('attemptId' in c && finishClaim(db, 't', crmDestination(before), 'l', c.attemptId, 'uncertain', null, NOW))
  // the same tenant and lead with a new token (rotation, reconnect, or a key for another account of the same CRM)
  assert.deepEqual(claimPush(db, 't', crmDestination(after), 'l', NOW + 1), { blocked: 'unknown' })
  assert.equal(crmDestination(before), crmDestination(after))
  assert.doesNotMatch(crmDestination(before), /token/, 'never the key')
  // the explicit, safe way on: the user resolves it, then the new key may push
  assert.ok(resolveClaim(db, 't', crmDestination(after), 'l', false, NOW + 2))
  assert.ok('attemptId' in claimPush(db, 't', crmDestination(after), 'l', NOW + 3))
  // Pipedrive is another system: its create cannot duplicate the HubSpot one; another tenant never shares a claim
  const d = claimPush(db, 't', crmDestination(PD), 'l2', NOW)
  assert.ok('attemptId' in d && finishClaim(db, 't', crmDestination(PD), 'l2', d.attemptId, 'uncertain', null, NOW))
  assert.ok('attemptId' in claimPush(db, 't', crmDestination(HS), 'l2', NOW))
  assert.ok('attemptId' in claimPush(db, 'other-tenant', crmDestination(PD), 'l2', NOW))
})
