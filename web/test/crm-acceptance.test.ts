import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { runCrmAcceptance, redactSecrets, type AcceptanceReport, type RecordedCase } from '../lib/crm/acceptance.ts'
import { pushLead, CrmPushError } from '../lib/crm/index.ts'
import { acceptanceConfig } from '../scripts/crm-live-acceptance.mts'
import { replayCase } from './helpers/crm-replay.ts'

// #569 live-provider acceptance harness, against an in-memory stub CRM (no network). The real run is a sandbox
// account only; these tests prove the harness catches what an id-only check cannot, and refuses anything else.
const KEY = 'sandbox-key-123'
type Opts = {
  accountType?: unknown; domain?: unknown; acceptAnyKey?: boolean; createBody?: (id: number) => unknown; forgetOnCreate?: boolean
  readEmail?: unknown; readBody?: (id: string) => unknown; readStatus?: number; deleteStatus?: number; deleteIgnored?: boolean; conflictId?: string; throwOnRead?: string
  // reads answered truthfully before readEmail / throwOnRead apply (pushLead's own read-back is the first read)
  honestReads?: number
}
function stubCrm(provider: 'hubspot' | 'pipedrive', o: Opts = {}) {
  const recs = new Map<string, { email: string; active: boolean }>()
  const calls: { method: string; url: string }[] = []
  let next = 100, reads = 0
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ method, url: url.replace(KEY, '[key]') })
    const u = new URL(url)
    const key = provider === 'hubspot' ? String((init?.headers as Record<string, string>)?.authorization ?? '').replace(/^Bearer /, '') : u.searchParams.get('api_token')
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
    if (key !== KEY && !o.acceptAnyKey) return j({ message: 'bad auth' }, 401)
    if (u.pathname === '/account-info/v3/details') return 'accountType' in o && typeof o.accountType === 'object' ? j(o.accountType) : o.accountType === 500 ? j({}, 500) : j({ accountType: o.accountType ?? 'DEVELOPER_TEST' })
    if (u.pathname === '/v1/users/me') return j({ success: true, data: { company_domain: 'domain' in o ? o.domain : 'dazl-sandbox' } })
    const m = /\/(contacts|persons)(?:\/(\d+))?$/.exec(u.pathname)
    if (!m) return j({}, 404)
    const id = m[2]
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { email?: string; properties?: { email?: string } }
      const email = (provider === 'hubspot' ? body.properties?.email : body.email) ?? ''
      if (provider === 'hubspot') {
        const dup = [...recs].find(([, r]) => r.email === email && r.active)
        if (dup) return j({ message: `Contact already exists. Existing ID: ${o.conflictId ?? dup[0]}` }, 409)
      }
      const nid = ++next
      if (!o.forgetOnCreate) recs.set(String(nid), { email, active: true })
      if (o.conflictId) recs.set(o.conflictId, { email, active: true })
      const b = o.createBody ? o.createBody(nid) : provider === 'hubspot' ? { id: String(nid) } : { success: true, data: { id: nid } }
      return j(b, 201)
    }
    if (method === 'DELETE') {
      if (o.deleteStatus) return j({}, o.deleteStatus)
      const r = recs.get(id!)
      if (r && !o.deleteIgnored) { if (provider === 'hubspot') recs.delete(id!); else r.active = false }
      return provider === 'hubspot' ? new Response(null, { status: 204 }) : j({ success: true, data: { id: Number(id) } })
    }
    const honest = reads++ < (o.honestReads ?? 0)
    if (o.throwOnRead && !honest) throw new Error(o.throwOnRead === 'url' ? `fetch failed for ${url}` : o.throwOnRead)
    if (o.readStatus && !honest) return j({}, o.readStatus)
    if (o.readBody && !honest) return j(o.readBody(id!))
    const r = recs.get(id!)
    if (!r || (provider === 'hubspot' && !r.active)) return j({ message: 'not found' }, 404)
    const email = honest || !('readEmail' in o) ? r.email : o.readEmail
    return provider === 'hubspot' ? j({ id: id, properties: { email } }) : j({ success: true, data: { id: Number(id), email: [{ value: email, primary: true }], active_flag: r.active } })
  }) as typeof fetch
  return { f, recs, calls }
}
const run = (provider: 'hubspot' | 'pipedrive', s: ReturnType<typeof stubCrm>, extra: { key?: string; expectDomain?: string } = {}) =>
  runCrmAcceptance({ provider, key: extra.key ?? KEY, runId: 'r1', fetchImpl: s.f, expectDomain: provider === 'pipedrive' ? ('expectDomain' in extra ? extra.expectDomain : 'dazl-sandbox') : undefined, now: new Date(0) })
const step = (r: AcceptanceReport, name: string) => r.steps.find(x => x.step === name)!
const posts = (s: ReturnType<typeof stubCrm>) => s.calls.filter(c => c.method === 'POST').length

test('hubspot sandbox: create, independent read-back, verified 409 naming the same id, delete confirmed gone', async () => {
  const s = stubCrm('hubspot')
  const r = await run('hubspot', s)
  assert.deepEqual(r.steps.map(x => [x.step, x.ok]), [['account', true], ['bad_key', true], ['create', true], ['read_back', true], ['duplicate', true], ['cleanup', true]])
  assert.equal(r.ok, true)
  assert.equal(r.recordId, '101')
  assert.equal(s.recs.size, 0, 'the synthetic record is gone')
  assert.match(step(r, 'bad_key').detail, /^failed: HubSpot 401/)
  assert.ok(!JSON.stringify(r).includes(KEY), 'the key never enters the report')
  assert.match(r.lead.contact, /@example\.com$/, 'a reserved example.com address, no real person')
})

test('pipedrive sandbox: create, read-back, no duplicate push (no unique email), soft delete confirmed', async () => {
  const s = stubCrm('pipedrive')
  const r = await run('pipedrive', s)
  assert.equal(r.ok, true, JSON.stringify(r.steps))
  assert.deepEqual(step(r, 'duplicate'), { step: 'duplicate', ok: true, skipped: true, detail: step(r, 'duplicate').detail })
  assert.equal(posts(s), 2, 'only the bad-key push and the one create')
  assert.equal(s.recs.get('101')?.active, false)
  assert.ok(!JSON.stringify(r).includes(KEY) && s.calls.every(c => !c.url.includes(KEY)))
})

test('not a sandbox, or unreadable: nothing is pushed at all', async () => {
  for (const accountType of ['STANDARD', 'APP_DEVELOPER', null, 42, 500, [], { accountType: ['SANDBOX'] }, { nope: 1 }]) {
    const s = stubCrm('hubspot', { accountType })
    const r = await run('hubspot', s)
    assert.deepEqual([r.ok, r.steps.length, step(r, 'account').ok, posts(s)], [false, 1, false, 0], `accountType ${JSON.stringify(accountType)}`)
  }
  for (const [domain, expectDomain] of [['real-company', 'dazl-sandbox'], [null, 'dazl-sandbox'], [7, 'dazl-sandbox'], ['dazl-sandbox', undefined]] as const) {
    const s = stubCrm('pipedrive', { domain })
    const r = await run('pipedrive', s, { expectDomain })
    assert.deepEqual([r.ok, r.steps.length, posts(s)], [false, 1, 0], `pipedrive ${String(domain)} / ${String(expectDomain)}`)
  }
  const thrown = await runCrmAcceptance({ provider: 'hubspot', key: KEY, runId: 'r1', fetchImpl: (async () => { throw new Error('ECONNRESET') }) as typeof fetch })
  assert.deepEqual([thrown.ok, thrown.steps.length, step(thrown, 'account').detail], [false, 1, 'account check failed: ECONNRESET'])
})

test('the #569 bug class: a {} 200 create is unknown, never a pass, and no read-back of a record that was never named', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    for (const body of [{}, null, [], { id: 5 }, { success: true, data: {} }, { success: true, data: { id: '7' } }]) {
      const s = stubCrm(provider, { createBody: () => body })
      const r = await run(provider, s)
      assert.equal(r.ok, false)
      assert.equal(r.recordId, null)
      assert.match(step(r, 'create').detail, /^unknown: /, `${provider} ${JSON.stringify(body)}`)
      assert.ok(step(r, 'read_back').skipped && step(r, 'cleanup').skipped)
      assert.ok(s.calls.every(c => c.method !== 'GET' || !/\/(contacts|persons)\/\d+/.test(c.url)), 'no read of an unnamed record')
    }
  }
})

test('pushLead itself catches an id the provider does not hold, or holding another email: create is unknown, the id is named, nothing deleted', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    const what = provider === 'hubspot' ? 'HubSpot named contact' : 'Pipedrive named person'
    for (const [why, o, msg] of [['ghost id', { forgetOnCreate: true }, 'has no such record'], ['another email', { readEmail: 'someone@else.test' }, "it does not hold this lead's email"]] as const) {
      const s = stubCrm(provider, o)
      const r = await run(provider, s)
      assert.deepEqual([r.ok, step(r, 'create').ok, step(r, 'create').detail], [false, false, `unknown: ${what} 101 but ${msg}; the ${provider === 'hubspot' ? 'contact' : 'person'} may or may not have been created`], `${provider} ${why}`)
      assert.equal(r.recordId, '101', 'the report names the record to check')
      assert.deepEqual([step(r, 'cleanup').ok, step(r, 'cleanup').skipped], [false, undefined])
      assert.match(step(r, 'cleanup').detail, /could not confirm record 101, so it was not deleted/)
      assert.equal(s.calls.filter(c => c.method === 'DELETE').length, 0, 'never deletes a record it did not verify')
    }
  }
})

// Review on 8f2827d7: cleanup deleted whatever id pushLead returned, even when the independent read-back showed a record
// that is not this run's. Now only a record step 3 verified is deleted.
test('the independent read-back sees another email after pushLead passed: no DELETE is sent and the id is reported', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    const s = stubCrm(provider, { readEmail: 'someone@else.test', honestReads: 1 })
    const r = await run(provider, s)
    assert.deepEqual([step(r, 'create').ok, step(r, 'read_back').ok, step(r, 'read_back').detail], [true, false, 'record 101, email differs'], provider)
    assert.deepEqual([r.ok, step(r, 'cleanup').ok], [false, false])
    assert.match(step(r, 'cleanup').detail, /^record 101 was not verified as this run's record, so it was not deleted/)
    assert.equal(s.calls.filter(c => c.method === 'DELETE').length, 0, 'no DELETE')
    assert.equal(s.recs.get('101')?.active, true, 'the record is left for the operator')
    const ghost = stubCrm(provider, { honestReads: 1, throwOnRead: 'ECONNRESET' })
    const g = await run(provider, ghost)
    assert.deepEqual([step(g, 'read_back').ok, step(g, 'cleanup').ok, ghost.calls.filter(c => c.method === 'DELETE').length], [false, false, 0], `${provider}: an unreadable record is not deleted either`)
  }
})

test('--record: every pushLead step becomes a replayable case with no key, no query string and no headers', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    const cases: RecordedCase[] = []
    const s = stubCrm(provider)
    const r = await runCrmAcceptance({ provider, key: KEY, runId: 'r1', fetchImpl: s.f, expectDomain: provider === 'pipedrive' ? 'dazl-sandbox' : undefined, now: new Date(0), record: c => { cases.push(c) } })
    assert.equal(r.ok, true, JSON.stringify(r.steps))
    assert.deepEqual(cases.map(c => [c.key, c.expect.outcome]), provider === 'hubspot' ? [['invalid', 'failed'], ['valid', 'ok'], ['valid', 'ok']] : [['invalid', 'failed'], ['valid', 'ok']])
    const text = JSON.stringify(cases)
    assert.ok(!text.includes(KEY) && !text.includes('api_token') && !/authorization|bearer/i.test(text), 'no key, no token parameter, no headers')
    assert.ok(cases.every(c => c.exchanges.every(x => !x.path.includes('?'))))
    // the create case holds the create and pushLead's read-back, and replays to the same outcome
    assert.deepEqual(cases[1].exchanges.map(x => [x.method, x.status]), [['POST', 201], ['GET', 200]])
    for (const c of cases) assert.deepEqual(await replayCase(c), { got: c.expect, problems: [], requests: c.exchanges.length }, c.name)
  }
  // a read-back that threw is recorded as status 0 and replays to the same unknown
  const cases: RecordedCase[] = []
  await runCrmAcceptance({ provider: 'hubspot', key: KEY, runId: 'r1', fetchImpl: stubCrm('hubspot', { throwOnRead: `down ${KEY}` }).f, now: new Date(0), record: c => { cases.push(c) } })
  const create = cases.find(c => c.name.startsWith('hubspot create'))!
  assert.deepEqual([create.expect.outcome, create.exchanges[1].status, create.exchanges[1].text], ['unknown', 0, 'down [key]'])
  assert.equal((await replayCase(create)).got.outcome, 'unknown')
})

test('an invalid key reported as success fails the bad_key step', async () => {
  const r = await run('hubspot', stubCrm('hubspot', { acceptAnyKey: true }))
  assert.equal(step(r, 'bad_key').ok, false)
  assert.equal(r.ok, false)
})

test('hubspot 409 naming a different record than the one created fails duplicate', async () => {
  const r = await run('hubspot', stubCrm('hubspot', { conflictId: '999' }))
  assert.equal(step(r, 'create').ok, true)
  assert.equal(step(r, 'duplicate').ok, false)
})

test('cleanup failures are named with the record id; a delete the provider ignored is not "gone"', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    const s5 = await run(provider, stubCrm(provider, { deleteStatus: 500 }))
    assert.deepEqual([s5.ok, step(s5, 'cleanup').detail], [false, 'delete answered 500'])
    assert.equal(s5.recordId, '101', 'the report names the record to remove by hand')
    const ign = await run(provider, stubCrm(provider, { deleteIgnored: true }))
    assert.match(step(ign, 'cleanup').detail, /^record 101 still readable after delete/)
  }
})

test('a thrown read carrying the key (raw or URL-encoded) is redacted in the report', async () => {
  const r = await run('hubspot', stubCrm('hubspot', { throwOnRead: `boom ${KEY} boom`, honestReads: 1 }))
  assert.equal(step(r, 'read_back').ok, false)
  assert.ok(!JSON.stringify(r).includes(KEY))
  assert.match(step(r, 'read_back').detail, /\[key\]/)
  const odd = 'key/with+odd?chars'
  const s = stubCrm('hubspot', { acceptAnyKey: true, honestReads: 1, throwOnRead: `boom ${encodeURIComponent(odd)}` })
  const e = await runCrmAcceptance({ provider: 'hubspot', key: odd, runId: 'r1', fetchImpl: s.f, now: new Date(0) })
  assert.ok(!JSON.stringify(e).includes(encodeURIComponent(odd)) && !JSON.stringify(e).includes(odd))
})

test('config: refuses unless CRM_ACCEPTANCE=sandbox, a known provider and a sane key (pipedrive also needs its domain)', () => {
  const ok = { CRM_ACCEPTANCE: 'sandbox', CRM_ACCEPTANCE_PROVIDER: 'hubspot', CRM_ACCEPTANCE_KEY: KEY }
  assert.deepEqual(acceptanceConfig(ok), { provider: 'hubspot', key: KEY, expectDomain: undefined })
  for (const env of [{}, { ...ok, CRM_ACCEPTANCE: 'yes' }, { ...ok, CRM_ACCEPTANCE: 'SANDBOX' }, { ...ok, CRM_ACCEPTANCE_PROVIDER: 'webhook' }, { ...ok, CRM_ACCEPTANCE_PROVIDER: undefined },
    { ...ok, CRM_ACCEPTANCE_KEY: '' }, { ...ok, CRM_ACCEPTANCE_KEY: '  ' }, { ...ok, CRM_ACCEPTANCE_KEY: 'a b' }, { ...ok, CRM_ACCEPTANCE_KEY: 'x'.repeat(501) },
    { ...ok, CRM_ACCEPTANCE_PROVIDER: 'pipedrive' }])
    assert.ok('refuse' in acceptanceConfig(env as Record<string, string | undefined>), JSON.stringify(env).slice(0, 80))
  assert.deepEqual(acceptanceConfig({ ...ok, CRM_ACCEPTANCE_PROVIDER: 'pipedrive', CRM_ACCEPTANCE_PIPEDRIVE_DOMAIN: 'dazl-sandbox' }), { provider: 'pipedrive', key: KEY, expectDomain: 'dazl-sandbox' })
})

test('the CLI refuses with exit 2 and makes no request without the sandbox confirmation', () => {
  const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', CRM_ACCEPTANCE_PROVIDER: 'hubspot', CRM_ACCEPTANCE_KEY: KEY } as unknown as NodeJS.ProcessEnv
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/crm-live-acceptance.mts'], { env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 2, r.stderr)
  assert.match(r.stderr, /refused: set CRM_ACCEPTANCE=sandbox/)
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY))
})

// ---- Review on 8f2827d7, the whole class: cleanup DELETE only for a record step 3 proved is this run's ----
const deletes = (s: ReturnType<typeof stubCrm>) => s.calls.filter(c => c.method === 'DELETE')
const WANT = 'dazl-acceptance-r1@example.com'
const UNVERIFIED: [string, Opts][] = [
  ['not found', { forgetOnCreate: true }], ['email differs', { readEmail: 'someone@else.test' }],
  ['read 500', { readStatus: 500 }], ['read 403', { readStatus: 403 }], ['read throws', { throwOnRead: 'ECONNRESET' }],
  ['email missing', { readEmail: undefined }], ['email null', { readEmail: null }], ['email number', { readEmail: 7 }], ['email list', { readEmail: [WANT] }],
  ['email empty', { readEmail: '' }], ['email upper case', { readEmail: WANT.toUpperCase() }], ['email mixed case', { readEmail: 'Dazl-Acceptance-r1@example.com' }],
  ['email padded', { readEmail: ` ${WANT} ` }], ['email trailing newline', { readEmail: `${WANT}\n` }], ['email +tag', { readEmail: 'dazl-acceptance-r1+x@example.com' }],
  ['email huge', { readEmail: WANT + 'x'.repeat(100_000) }], ['email of another run', { readEmail: 'dazl-acceptance-r2@example.com' }],
]
const GARBLED: Record<'hubspot' | 'pipedrive', [string, Opts][]> = {
  hubspot: [['id mismatch', { readBody: () => ({ id: '102', properties: { email: WANT } }) }], ['numeric id', { readBody: () => ({ id: 101, properties: { email: WANT } }) }],
    ['no properties', { readBody: id => ({ id }) }], ['garbled body', { readBody: () => 'not json' }], ['null body', { readBody: () => null }], ['array body', { readBody: id => [{ id, properties: { email: WANT } }] }]],
  pipedrive: [['id mismatch', { readBody: () => ({ success: true, data: { id: 102, email: [{ value: WANT }], active_flag: true } }) }], ['string id', { readBody: () => ({ success: true, data: { id: '101', email: [{ value: WANT }], active_flag: true } }) }],
    ['success false', { readBody: () => ({ success: false, data: { id: 101, email: [{ value: WANT }], active_flag: true } }) }], ['email not a list', { readBody: () => ({ success: true, data: { id: 101, email: WANT, active_flag: true } }) }],
    ['email objects garbled', { readBody: () => ({ success: true, data: { id: 101, email: [{ v: WANT }, 5, null], active_flag: true } }) }], ['soft-deleted', { readBody: () => ({ success: true, data: { id: 101, email: [{ value: WANT }], active_flag: false } }) }]],
}

test('step 3 unverified, every way (not found, unreadable, id mismatch, missing/other/case/whitespace email): no re-push, no DELETE, left for operator', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    for (const [name, o] of [...UNVERIFIED, ...GARBLED[provider]]) {
      // honestReads 1: pushLead's own read-back passes, so this is the harness's independent step 3 deciding
      const s = stubCrm(provider, { ...o, honestReads: 1 })
      const r = await run(provider, s)
      const label = `${provider} ${name}`
      assert.equal(step(r, 'create').ok, !o.forgetOnCreate, label)
      assert.equal(deletes(s).length, 0, `${label}: no DELETE`)
      assert.equal(posts(s), 2, `${label}: no duplicate push of an unverified record`)
      assert.deepEqual([r.ok, step(r, 'cleanup').ok, r.recordId, r.leftForOperator.map(x => x.id)], [false, false, '101', ['101']], label)
      assert.match(r.leftForOperator[0].reason, /^unverified, left for operator: /, label)
      assert.ok(r.leftForOperator[0].reason.length < 400 && step(r, 'read_back').detail.length < 400, `${label}: no huge provider value echoed`)
      if (!o.forgetOnCreate) {
        assert.equal(step(r, 'read_back').ok, false, label)
        assert.match(step(r, 'cleanup').detail, /^record 101 was not verified as this run's record, so it was not deleted \(unverified, left for operator: /, label)
        assert.equal(step(r, 'duplicate').skipped, true, label)
      }
    }
  }
})

test('the same cases seen by pushLead\'s own read-back first: still no DELETE and the id is left for the operator', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    for (const [name, o] of [...UNVERIFIED, ...GARBLED[provider]]) {
      const s = stubCrm(provider, o)
      const r = await run(provider, s)
      const label = `${provider} ${name}`
      assert.equal(deletes(s).length, 0, `${label}: no DELETE`)
      assert.deepEqual([r.ok, step(r, 'cleanup').ok, r.leftForOperator.map(x => x.id)], [false, false, ['101']], label)
    }
  }
})

test('the positive control still cleans up: an exact-email, same-id read-back is deleted and nothing is left over', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    const s = stubCrm(provider)
    const r = await run(provider, s)
    assert.deepEqual([r.ok, deletes(s).length, r.leftForOperator], [true, 1, []], provider)
    assert.match(deletes(s)[0].url, /\/(contacts|persons)\/101(\?|$)/)
  }
})

test('pushLead naming a null, non-string or malformed id: create fails, nothing is read, re-pushed or deleted', async () => {
  for (const externalId of [null, undefined, 101, 0, true, {}, ['101'], '', ' 101', '101 ', '0', '-1', '1e3', '101/../102', '101?x=1', 'abc', '9'.repeat(21)]) {
    const s = stubCrm('hubspot')
    let n = 0
    const pushImpl = (async (cfg: Parameters<typeof pushLead>[0], lead: Parameters<typeof pushLead>[1], f?: typeof fetch) => {
      if (cfg.key !== KEY) return pushLead(cfg, lead, f)
      n++
      return { message: 'Contact created in HubSpot', externalId } as unknown as Awaited<ReturnType<typeof pushLead>>
    }) as typeof pushLead
    const r = await runCrmAcceptance({ provider: 'hubspot', key: KEY, runId: 'r1', fetchImpl: s.f, pushImpl, now: new Date(0) })
    const label = JSON.stringify(externalId) ?? String(externalId)
    assert.equal(n, 1, `${label}: one create push only`)
    assert.deepEqual([r.ok, r.recordId, step(r, 'create').ok, step(r, 'read_back').skipped, step(r, 'cleanup').skipped], [false, null, false, true, true], label)
    assert.match(step(r, 'create').detail, /unusable id .*check the sandbox/, label)
    assert.ok(s.calls.every(c => c.method !== 'DELETE' && !/\/contacts\/./.test(c.url)), `${label}: no read or delete of anything`)
  }
  // a CrmPushError naming a malformed id is not trusted as a record id either
  const bad = (async (cfg: Parameters<typeof pushLead>[0], lead: Parameters<typeof pushLead>[1], f?: typeof fetch) => {
    if (cfg.key !== KEY) return pushLead(cfg, lead, f)
    throw new CrmPushError('odd', 'unknown', '1/../2')
  }) as typeof pushLead
  const e = await runCrmAcceptance({ provider: 'hubspot', key: KEY, runId: 'r1', fetchImpl: stubCrm('hubspot').f, pushImpl: bad, now: new Date(0) })
  assert.deepEqual([e.recordId, e.leftForOperator, step(e, 'cleanup').skipped], [null, [], true])
  // a push that resolves to nothing at all, or throws a non-Error, is a failed create, never a crash
  for (const pushImpl of [async () => null, async () => 'ok', async () => { throw 'boom' }] as unknown as (typeof pushLead)[]) {
    const r = await runCrmAcceptance({ provider: 'hubspot', key: KEY, runId: 'r1', fetchImpl: stubCrm('hubspot').f, pushImpl, now: new Date(0) })
    assert.deepEqual([r.ok, r.recordId, step(r, 'create').ok], [false, null, false])
  }
})

test('a duplicate push naming another record leaves it for the operator; only the verified record is deleted', async () => {
  const s = stubCrm('hubspot', { conflictId: '999' })
  const r = await run('hubspot', s)
  assert.equal(step(r, 'duplicate').ok, false)
  assert.deepEqual(r.leftForOperator.map(x => x.id), ['999'])
  assert.deepEqual(deletes(s).map(c => c.url), ['https://api.hubapi.com/crm/v3/objects/contacts/101'])
})

// ---- Review on 8f2827d7: the Pipedrive token rides in the URL query string; no error, log or report may carry it ----
const PD_KEY = 'pd/tok+en=&1%'
test('a fetch error quoting the token URL is redacted: account check, step 3 read-back, the helper', async () => {
  // every request throws with its own URL (as undici's "Failed to parse URL from <url>" does)
  const echo = (async (input: string | URL) => { throw new TypeError(`Failed to parse URL from ${String(input)}`) }) as typeof fetch
  const acct = await runCrmAcceptance({ provider: 'pipedrive', key: PD_KEY, runId: 'r1', expectDomain: 'dazl-sandbox', fetchImpl: echo, now: new Date(0) })
  const text = JSON.stringify(acct)
  assert.ok(!text.includes(PD_KEY) && !text.includes(encodeURIComponent(PD_KEY)), text)
  assert.match(step(acct, 'account').detail, /users\/me\?api_token=\[redacted\]/)
  const s = stubCrm('pipedrive', { throwOnRead: 'url', honestReads: 1 })
  const r = await run('pipedrive', s)
  assert.equal(step(r, 'read_back').ok, false)
  assert.ok(!JSON.stringify(r).includes(KEY))
  assert.match(step(r, 'read_back').detail, /persons\/101\?api_token=\[redacted\]/)
  assert.equal(deletes(s).length, 0)
  for (const t of [`x ${PD_KEY} y`, `https://h/p?api_token=${encodeURIComponent(PD_KEY)}&a=1`, 'https://h/p?a=1&API_TOKEN=other-secret#f', 'u?token=zzz', 'u?access_token=zzz'])
    assert.ok(!/pd\/tok|pd%2Ftok|other-secret|zzz/.test(redactSecrets(t, PD_KEY)), t)
  assert.equal(redactSecrets('nothing secret here', PD_KEY), 'nothing secret here')
})

test('pushLead (the production path) never puts the Pipedrive token URL into its error, on create or on its read-back', async () => {
  const urlErr = (u: string) => new TypeError(`Failed to parse URL from ${u}`)
  const lead = { company: 'C', name: 'N', contact: 'a@example.com', signal: '', source_url: '' }
  const fetches: (typeof fetch)[] = [
    (async (u: string) => { throw urlErr(u) }) as unknown as typeof fetch,
    (async (u: string) => { throw Object.assign(new Error(`connect ECONNREFUSED ${u}`), { cause: { code: 'ECONNREFUSED' } }) }) as unknown as typeof fetch,
    // the create answers, then pushLead's own read-back throws quoting its token URL
    (async (u: string, init?: RequestInit) => { if (init?.method === 'POST') return new Response(JSON.stringify({ success: true, data: { id: 101 } }), { status: 201 }); throw urlErr(u) }) as unknown as typeof fetch,
  ]
  for (const f of fetches) {
    const e = await pushLead({ provider: 'pipedrive', key: PD_KEY }, lead, f).then(() => null, (x: unknown) => x)
    assert.ok(e instanceof CrmPushError)
    const all = `${e.message} ${e.stack ?? ''} ${JSON.stringify(e)} ${String((e as { cause?: unknown }).cause ?? '')}`
    assert.ok(!all.includes(PD_KEY) && !all.includes(encodeURIComponent(PD_KEY)) && !all.includes('api_token'), all)
  }
})

test('the CLI never prints the key, even when every request fails quoting its URL', () => {
  // The net fence scrubs every *KEY* variable, so the key rides in as CRM_ACCEPTANCE_K and a preload puts it back, then
  // replaces fetch with one that throws quoting its URL. No provider is ever called.
  const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', CRM_ACCEPTANCE: 'sandbox', CRM_ACCEPTANCE_PROVIDER: 'pipedrive', CRM_ACCEPTANCE_K: PD_KEY, CRM_ACCEPTANCE_PIPEDRIVE_DOMAIN: 'dazl-sandbox' } as unknown as NodeJS.ProcessEnv
  const preload = 'data:text/javascript,' + encodeURIComponent("process.env.CRM_ACCEPTANCE_KEY = process.env.CRM_ACCEPTANCE_K; globalThis.fetch = async (u) => { throw new TypeError('Failed to parse URL from ' + String(u)) }")
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--import', preload, 'scripts/crm-live-acceptance.mts'], { env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 1, r.stderr)
  const out = r.stdout + r.stderr
  assert.ok(!out.includes(PD_KEY) && !out.includes(encodeURIComponent(PD_KEY)), out)
  assert.match(r.stderr, /FAIL account: account check failed: Failed to parse URL from https:\/\/api\.pipedrive\.com\/v1\/users\/me\?api_token=\[redacted\]/)
})
