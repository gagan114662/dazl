// #365 (narrow patch): a CRM push is reported as done only when the CRM's answer names the record it created or the
// lead's own existing record. An answer that may hide a created record is 'unknown' and blocks a blind retry; a definite
// refusal is 'failed'. The generic webhook keeps its own protocol (any 2xx, 204 included, with no record id). Isolated
// mocks only: no CRM request leaves the process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CrmPushError, pushLead, type CrmConfig, type CrmLead } from '../lib/crm/index.ts'
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
  assert.match(r.stdout, /# pass 4\b/)
  assert.match(r.stdout, /# fail 0\b/)
})
