// Fixture-only tests for the master-key rewrap tool: synthetic databases, random
// throwaway keys, no real credentials, no production backups.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { encryptSecret, decryptSecret, rewrapSecret } from '../lib/secrets.ts'
import { rewrapMasterKey, verifyMasterKey, REWRAP_COLUMNS } from '../lib/secrets-rewrap.ts'

const OLD = randomBytes(32)
const NEW = randomBytes(32)

function fixtureDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE tenant_llm_keys (tenant_id TEXT NOT NULL, vendor TEXT NOT NULL, ciphertext TEXT NOT NULL, last4 TEXT NOT NULL, validated_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, vendor));
           CREATE TABLE tenant_connectors (tenant_id TEXT NOT NULL, connector TEXT NOT NULL, ciphertext TEXT NOT NULL, last4 TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, connector));
           CREATE TABLE gmail_accounts (tenant_id TEXT PRIMARY KEY, email TEXT NOT NULL, refresh_ct TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', connected_at INTEGER NOT NULL DEFAULT 0);`)
  db.prepare('INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4) VALUES (?, ?, ?, ?)').run('t1', 'anthropic', encryptSecret('fixture-llm-secret-1', 'llm-key:t1:anthropic', OLD), '...1')
  db.prepare('INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4) VALUES (?, ?, ?, ?)').run('t1', 'openai', encryptSecret('fixture-llm-secret-2', 'llm-key:t1:openai', OLD), '...2')
  db.prepare('INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4) VALUES (?, ?, ?, ?)').run('t2', 'enrich:apollo', encryptSecret('fixture-apollo-secret', 'connector:t2:enrich:apollo', OLD), '...3')
  db.prepare('INSERT INTO gmail_accounts (tenant_id, email, refresh_ct) VALUES (?, ?, ?)').run('t3', 't3@example.com', encryptSecret('fixture-gmail-refresh', 'gmail-refresh:t3', OLD))
  return db
}

const llmBlob = (db: Database.Database) => (db.prepare("SELECT ciphertext c FROM tenant_llm_keys WHERE tenant_id='t1' AND vendor='anthropic'").get() as { c: string }).c
const bodyOf = (b: string) => { const o = JSON.parse(b); return `${o.iv}|${o.ct}|${o.tag}` }

test('rewrap migrates all three registered columns; secret bodies byte-identical; plaintexts identical under the new key; old key fails', () => {
  const db = fixtureDb()
  const before = { llm: llmBlob(db), gmail: (db.prepare("SELECT refresh_ct c FROM gmail_accounts WHERE tenant_id='t3'").get() as { c: string }).c }
  const results = rewrapMasterKey(db, OLD, NEW)
  assert.deepEqual(results.map(r => [r.table, r.rewrapped, r.skipped, r.missing]), [['tenant_llm_keys', 2, 0, false], ['tenant_connectors', 1, 0, false], ['gmail_accounts', 1, 0, false]])
  assert.equal(decryptSecret(llmBlob(db), 'llm-key:t1:anthropic', NEW), 'fixture-llm-secret-1')
  assert.equal(decryptSecret((db.prepare("SELECT ciphertext c FROM tenant_llm_keys WHERE tenant_id='t1' AND vendor='openai'").get() as { c: string }).c, 'llm-key:t1:openai', NEW), 'fixture-llm-secret-2')
  assert.equal(decryptSecret((db.prepare("SELECT ciphertext c FROM tenant_connectors WHERE tenant_id='t2'").get() as { c: string }).c, 'connector:t2:enrich:apollo', NEW), 'fixture-apollo-secret')
  assert.equal(decryptSecret((db.prepare("SELECT refresh_ct c FROM gmail_accounts WHERE tenant_id='t3'").get() as { c: string }).c, 'gmail-refresh:t3', NEW), 'fixture-gmail-refresh')
  assert.throws(() => decryptSecret(llmBlob(db), 'llm-key:t1:anthropic', OLD), 'old key no longer opens rewrapped rows')
  assert.equal(bodyOf(llmBlob(db)), bodyOf(before.llm), 'secret BODY bytes (iv/ct/tag) unchanged by the rewrap')
  assert.equal(bodyOf((db.prepare("SELECT refresh_ct c FROM gmail_accounts WHERE tenant_id='t3'").get() as { c: string }).c), bodyOf(before.gmail))
  assert.throws(() => decryptSecret(llmBlob(db), 'llm-key:t1:openai', NEW), 'context binding survives: not readable under another row context')
})

test('idempotence: a second run changes nothing; rollback is the symmetric run', () => {
  const db = fixtureDb()
  const original = llmBlob(db)
  rewrapMasterKey(db, OLD, NEW)
  const second = rewrapMasterKey(db, OLD, NEW)
  assert.ok(second.every(r => r.rewrapped === 0 && !r.missing), 'already-current rows are skipped')
  const back = rewrapMasterKey(db, NEW, OLD)
  assert.ok(back.every(r => r.rewrapped > 0 || r.missing))
  assert.equal(decryptSecret(llmBlob(db), 'llm-key:t1:anthropic', OLD), 'fixture-llm-secret-1')
  assert.equal(bodyOf(llmBlob(db)), bodyOf(original), 'body bytes still match the ORIGINAL blob after a round trip')
})

test('fails closed on a wrong old key: aborts, modifies nothing, error carries no secret material', () => {
  const db = fixtureDb()
  const before = llmBlob(db)
  assert.throws(() => rewrapMasterKey(db, randomBytes(32), NEW), /preflight failed/)
  assert.equal(llmBlob(db), before)
  assert.equal(decryptSecret(before, 'llm-key:t1:anthropic', OLD), 'fixture-llm-secret-1', 'old key still valid after aborted run')
})

test('preflight: corrupt or unknown-version rows abort BEFORE any write - zero rows change', () => {
  const db = fixtureDb()
  const beforeLlm = llmBlob(db)
  db.prepare("UPDATE tenant_connectors SET ciphertext = 'not json' WHERE tenant_id='t2'").run()
  db.prepare("UPDATE gmail_accounts SET refresh_ct = ? WHERE tenant_id='t3'").run(JSON.stringify({ v: 2, iv: 'x', ct: 'x', tag: 'x', wiv: 'x', wct: 'x', wtag: 'x' }))
  let msg = ''
  try { rewrapMasterKey(db, OLD, NEW) } catch (e) { msg = e instanceof Error ? e.message : '' }
  assert.ok(msg.includes('preflight failed') && msg.includes('NO rows were written'), 'abort names the preflight guarantee')
  assert.ok(!msg.includes('fixture-') && !msg.includes('not json'), 'error carries no blob or plaintext material')
  // The critical guarantee: although the llm rows were valid and listed first,
  // NOTHING was written - a corrupt later row can never leave partial state.
  assert.equal(llmBlob(db), beforeLlm)
  assert.equal(decryptSecret(beforeLlm, 'llm-key:t1:anthropic', OLD), 'fixture-llm-secret-1', 'old key still valid, nothing migrated')
  // Fix the rows; a fresh run completes everything.
  db.prepare("UPDATE tenant_connectors SET ciphertext = ? WHERE tenant_id='t2'").run(encryptSecret('fixture-apollo-secret', 'connector:t2:enrich:apollo', OLD))
  db.prepare("UPDATE gmail_accounts SET refresh_ct = ? WHERE tenant_id='t3'").run(encryptSecret('fixture-gmail-refresh', 'gmail-refresh:t3', OLD))
  const run = rewrapMasterKey(db, OLD, NEW)
  assert.deepEqual(run.map(r => [r.rewrapped, r.skipped, r.corrupt]), [[2, 0, 0], [1, 0, 0], [1, 0, 0]])
  assert.equal(decryptSecret((db.prepare("SELECT refresh_ct c FROM gmail_accounts WHERE tenant_id='t3'").get() as { c: string }).c, 'gmail-refresh:t3', NEW), 'fixture-gmail-refresh')
})

test('a blob changed between runs is rewrapped from its CURRENT bytes, never a stale overwrite', () => {
  // Honesty boundary: the per-write compare-and-swap guards the preflight-to-write
  // window as defense-in-depth, but a live multi-connection concurrent-writer abort
  // is NOT proven by this suite - the procedure requires a fenced single-writer
  // window. What IS proven here: a row changed since a prior dry run is re-read and
  // rewrapped from its current bytes, so no stale precomputed blob can clobber it.
  const db = fixtureDb()
  const dry = rewrapMasterKey(db, OLD, NEW, { dryRun: true })
  assert.ok(dry.every(r => r.rewrapped > 0 && !r.missing), 'dry run reports what would change')
  db.prepare("UPDATE tenant_llm_keys SET ciphertext = ? WHERE tenant_id='t1' AND vendor='openai'").run(encryptSecret('fixture-llm-secret-2b', 'llm-key:t1:openai', OLD))
  const real = rewrapMasterKey(db, OLD, NEW)
  assert.equal(decryptSecret((db.prepare("SELECT ciphertext c FROM tenant_llm_keys WHERE tenant_id='t1' AND vendor='openai'").get() as { c: string }).c, 'llm-key:t1:openai', NEW), 'fixture-llm-secret-2b', 'the newer write was rewrapped from its CURRENT bytes, never clobbered with a stale rewrap')
  assert.ok(real.every(r => !r.missing))
})

test('dry run writes nothing', () => {
  const db = fixtureDb()
  const before = llmBlob(db)
  const r = rewrapMasterKey(db, OLD, NEW, { dryRun: true })
  assert.ok(r.every(x => x.rewrapped > 0 && !x.missing))
  assert.equal(llmBlob(db), before)
  assert.equal(decryptSecret(before, 'llm-key:t1:anthropic', OLD), 'fixture-llm-secret-1')
})

test('quarantine recovery: corrupt rows cannot block migration or rollback of healthy rows, and stay loudly counted', () => {
  const db = fixtureDb()
  db.prepare("UPDATE tenant_connectors SET ciphertext = 'not json' WHERE tenant_id='t2'").run()
  db.prepare("UPDATE gmail_accounts SET refresh_ct = ? WHERE tenant_id='t3'").run(JSON.stringify({ v: 2, iv: 'x', ct: 'x', tag: 'x', wiv: 'x', wct: 'x', wtag: 'x' }))
  assert.throws(() => rewrapMasterKey(db, OLD, NEW), /preflight failed/, 'default mode refuses to start: preflight abort, zero writes')
  // Operator-chosen recovery mode: healthy rows migrate, corrupt rows counted and skipped.
  const fwd = rewrapMasterKey(db, OLD, NEW, { quarantineCorrupt: true })
  assert.deepEqual(fwd.map(r => [r.rewrapped, r.skipped, r.corrupt]), [[2, 0, 0], [0, 0, 1], [0, 0, 1]], 'healthy rows migrated; both corrupt rows quarantined, none silently dropped')
  assert.equal(decryptSecret(llmBlob(db), 'llm-key:t1:anthropic', NEW), 'fixture-llm-secret-1')
  // Rollback recovers every recoverable row; the same corrupt rows still cannot block it.
  const back = rewrapMasterKey(db, NEW, OLD, { quarantineCorrupt: true })
  assert.deepEqual(back.map(r => [r.rewrapped, r.corrupt]), [[2, 0], [0, 1], [0, 1]])
  assert.equal(decryptSecret(llmBlob(db), 'llm-key:t1:anthropic', OLD), 'fixture-llm-secret-1', 'recovered under the old key')
  // Corrupt rows are untouched, still loudly corrupt, and verify reports them as
  // unknown-affected - never as healthy.
  assert.equal((db.prepare("SELECT ciphertext c FROM tenant_connectors WHERE tenant_id='t2'").get() as { c: string }).c, 'not json')
  const v = verifyMasterKey(db, OLD)
  assert.deepEqual(v.map(r => [r.ok, r.bad]), [[2, 0], [0, 1], [0, 1]], 'verify counts unreadable rows as bad, does not throw, does not claim health')
})

test('a globally wrong old key cannot succeed even in quarantine mode: zero writes, everything counted bad', () => {
  const db = fixtureDb()
  const before = llmBlob(db)
  const WRONG = randomBytes(32)
  assert.throws(() => rewrapMasterKey(db, WRONG, NEW), /preflight failed/, 'default mode: preflight abort')
  const r = rewrapMasterKey(db, WRONG, NEW, { quarantineCorrupt: true })
  assert.equal(r.reduce((n, x) => n + x.rewrapped, 0), 0, 'nothing rewrapped under a wrong key')
  assert.equal(r.reduce((n, x) => n + x.corrupt, 0), 4, 'all 4 rows counted corrupt')
  assert.equal(llmBlob(db), before, 'zero writes')
  assert.ok(verifyMasterKey(db, NEW).every(x => x.ok === 0 && x.bad === x.total), 'post-run gate would fail: nothing decrypts under the new key')
})

test('verifyMasterKey: after a clean migration every row verifies under the new key and none under the old', () => {
  const db = fixtureDb()
  rewrapMasterKey(db, OLD, NEW)
  const vNew = verifyMasterKey(db, NEW)
  assert.deepEqual(vNew.map(r => [r.total, r.ok, r.bad]), [[2, 2, 0], [1, 1, 0], [1, 1, 0]], 'the post-run gate input: all rows current under the new key')
  const vOld = verifyMasterKey(db, OLD)
  assert.ok(vOld.every(r => r.ok === 0 && r.bad === r.total), 'old key fully retired from live rows')
  assert.equal(rewrapMasterKey(db, OLD, NEW).every(r => r.rewrapped === 0 && r.corrupt === 0), true, 're-check: 0 would change, 0 corrupt')
})

test('registry is exactly the three known ciphertext columns (fail-closed allowlist)', () => {
  assert.deepEqual(REWRAP_COLUMNS.map(c => `${c.table}.${c.column}`).sort(), ['gmail_accounts.refresh_ct', 'tenant_connectors.ciphertext', 'tenant_llm_keys.ciphertext'])
  assert.equal(rewrapMasterKey(new Database(':memory:'), OLD, NEW).every(r => r.missing), true, 'a database without the tables is reported, not invented')
})

test('identical old/new keys rejected; rewrapSecret rejects malformed blobs without leaking material', () => {
  const db = fixtureDb()
  assert.throws(() => rewrapMasterKey(db, OLD, OLD), /identical/)
  for (const bad of ['', 'null', '{}', JSON.stringify({ v: 1, iv: 1, ct: 'x', tag: 'x', wiv: 'x', wct: 'x', wtag: 'x' })]) {
    let msg = ''
    try { rewrapSecret(bad, 'llm-key:t1:anthropic', OLD, NEW) } catch (e) { msg = e instanceof Error ? e.message : '' }
    assert.ok(msg.length > 0)
    assert.ok(!msg.includes('fixture'), 'no material in errors')
  }
})
