import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { runCrmAcceptance, type AcceptanceReport } from '../lib/crm/acceptance.ts'
import { acceptanceConfig } from '../scripts/crm-live-acceptance.mts'

// #569 live-provider acceptance harness, against an in-memory stub CRM (no network). The real run is a sandbox
// account only; these tests prove the harness catches what an id-only check cannot, and refuses anything else.
const KEY = 'sandbox-key-123'
type Opts = {
  accountType?: unknown; domain?: unknown; acceptAnyKey?: boolean; createBody?: (id: number) => unknown; forgetOnCreate?: boolean
  readEmail?: string; deleteStatus?: number; deleteIgnored?: boolean; conflictId?: string; throwOnRead?: string
}
function stubCrm(provider: 'hubspot' | 'pipedrive', o: Opts = {}) {
  const recs = new Map<string, { email: string; active: boolean }>()
  const calls: { method: string; url: string }[] = []
  let next = 100
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
    if (o.throwOnRead) throw new Error(o.throwOnRead)
    const r = recs.get(id!)
    if (!r || (provider === 'hubspot' && !r.active)) return j({ message: 'not found' }, 404)
    const email = o.readEmail ?? r.email
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

test('a provider that names an id it does not hold, or holds another email, fails read-back', async () => {
  for (const provider of ['hubspot', 'pipedrive'] as const) {
    const ghost = await run(provider, stubCrm(provider, { forgetOnCreate: true }))
    assert.deepEqual([ghost.ok, step(ghost, 'create').ok, step(ghost, 'read_back').ok, step(ghost, 'read_back').detail], [false, true, false, 'the provider has no record with that id'])
    const other = await run(provider, stubCrm(provider, { readEmail: 'someone@else.test' }))
    assert.deepEqual([other.ok, step(other, 'read_back').detail], [false, 'record 101, email differs'])
  }
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

test('a thrown read carrying the key is redacted in the report', async () => {
  const r = await run('hubspot', stubCrm('hubspot', { throwOnRead: `boom ${KEY} boom` }))
  assert.equal(step(r, 'read_back').ok, false)
  assert.ok(!JSON.stringify(r).includes(KEY))
  assert.match(step(r, 'read_back').detail, /\[key\]/)
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
