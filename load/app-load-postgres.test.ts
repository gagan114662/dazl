import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkIsolation, postgresTarget, assertNoRawSqliteModules } from './app-load-postgres.ts'

test('foreign probes fail on a foreign row even with 404 or a disguised response', () => {
  const probe = { own: 'own-marker', foreign: ['foreign-marker', 'foreign-row-id'] }
  assert.deepEqual(checkIsolation(404, '{"error":"Not found"}', probe, true), { leak: false, correct: true })
  for (const status of [200, 404, 500]) {
    assert.deepEqual(checkIsolation(status, '{"leads":[{"id":"foreign-row-id"}]}', probe, true), { leak: true, correct: false })
  }
  assert.deepEqual(checkIsolation(200, '{"leads":[{"id":"unknown-row"}]}', probe, true), { leak: true, correct: false })
  assert.deepEqual(checkIsolation(200, '{"leads":[]}', probe, true), { leak: false, correct: false })
  assert.deepEqual(checkIsolation(404, '{"leads":[{"id":"unknown-row"}]}', probe, true), { leak: true, correct: false })
})

test('owner route control must return its own marker, and rejects mixed ownership', () => {
  const probe = { own: 'own-marker', foreign: ['foreign-marker'] }
  assert.deepEqual(checkIsolation(200, '{"company":"own-marker"}', probe), { leak: false, correct: true })
  assert.deepEqual(checkIsolation(200, '{"company":"own-marker foreign-marker"}', probe), { leak: true, correct: false })
  assert.deepEqual(checkIsolation(200, '{}', probe), { leak: false, correct: false })
})

test('postgres target is a dedicated local database without caller-supplied schema options', () => {
  assert.equal(postgresTarget('postgres://test@127.0.0.1/dazl_load_test').pathname, '/dazl_load_test')
  for (const url of ['postgres://test@db.example/dazl_load_test', 'postgres://test@localhost/postgres',
    'postgres://test@localhost/dazl_load_test?options=-c%20search_path=public']) {
    assert.throws(() => postgresTarget(url))
  }
})


test('the preload supplies a real SDK stream and fences unrelated provider hosts', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'load-preload-test-'))
  const trace = path.join(dir, 'trace')
  try {
    const script = `
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      const { default: Anthropic } = createRequire(process.cwd() + '/web/package.json')('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey: 'fixture', maxRetries: 0 })
      const res = await client.beta.messages.stream({ model: 'claude-sonnet-4-5', max_tokens: 256, messages: [{ role: 'user', content: 'fixture' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] }).finalMessage()
      assert.equal(res.stop_reason, 'end_turn')
      assert.deepEqual(JSON.parse(res.content[0].text).leads, [])
      await assert.rejects(fetch('https://unrelated-provider.invalid/'), /test net fence/)
    `
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './load/app-load-postgres-preload.ts',
      '--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, LOAD_PG_SCENARIO_URL: 'postgres://test@127.0.0.1/dazl_load_test',
        LOAD_PG_SCENARIO_MASTER: Buffer.alloc(32).toString('base64'), LOAD_PG_SCENARIO_TRACE: trace },
    })
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.equal(readFileSync(trace, 'utf8'), 'search\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('Postgres load accepts an empty raw-SQLite manifest and refuses every nonempty manifest', () => {
  assert.doesNotThrow(() => assertNoRawSqliteModules({}))
  assert.throws(() => assertNoRawSqliteModules({ 'one-runtime-module.ts': 0 }), /1 raw SQLite module/)
  assert.throws(() => assertNoRawSqliteModules({ 'first.ts': 0, 'second.ts': 3 }), /2 raw SQLite modules/)
})

test('the own Leads probe requires all seeded buying-need verdicts', () => {
  const probe = { own: 'owner-marker', foreign: ['foreign-marker'], triggerLeadIds: ['lead-a', 'lead-b'] }
  const a = { id: 'lead-a', company: 'owner-marker', buying_need: 'trigger_only' }
  const b = { id: 'lead-b', company: 'owner-marker', buying_need: 'trigger_only' }
  const read = (leads: unknown[]) => checkIsolation(200, JSON.stringify({ leads }), probe)
  assert.deepEqual(read([a, b]), { leak: false, correct: true })
  assert.deepEqual(read([a]), { leak: false, correct: false })
  assert.deepEqual(read([a, a]), { leak: false, correct: false })
  assert.deepEqual(read([a, { ...b, buying_need: null }]), { leak: false, correct: false })
})
