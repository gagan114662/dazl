// Refs #1099, Gagan's rule (15 Nov 03:38): dazl calls no paid third-party API in its default path except Claude. Every gate below runs with
// DAZL_PAID_VENDORS empty (the default an operator gets) and proves NO request reaches the vendor; a control names the vendor and proves
// the same code still runs when an operator opts in. Tests of the vendor code paths opt in (test/paid-vendors-on.ts),
// so each test here sets the variable itself. Invented companies and keys; fake fetch; no network.
// Part of the #1273 split: the scan's model vendor (runner.ts pickVendor) and the key gates.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { usableVendor } from '../lib/paid-vendors.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateKeys, saveKey, defaultVendor, hasKey, readHasKey } from '../lib/llm/key-store.ts'
import { pickVendor } from '../lib/scan/runner.ts'

const OFF = { DAZL_PAID_VENDORS: '' }
const master = randomBytes(32)

test('model vendor: a saved OpenAI key is not used unless named; the Anthropic key is used even when it is older', async () => {
  const db = new Database(':memory:'); migrateKeys(db)
  saveKey(db, 't1', 'anthropic', 'sk-ant-' + 'a'.repeat(40), master)
  db.prepare("UPDATE tenant_llm_keys SET created_at = created_at - 100 WHERE tenant_id = 't1'").run()
  saveKey(db, 't1', 'openai', 'sk-' + 'b'.repeat(40), master)
  assert.equal(pickVendor(db, 't1', OFF), 'anthropic')
  assert.equal(defaultVendor(db, 't1', OFF), 'anthropic')
  assert.equal(pickVendor(db, 't1', { DAZL_PAID_VENDORS: 'openai' }), 'openai', 'named: the newest key, as before')
  saveKey(db, 't2', 'openai', 'sk-' + 'c'.repeat(40), master)
  assert.equal(pickVendor(db, 't2', OFF), null, 'only an OpenAI key: no usable key')
  // ...and every intake gate (scan, play, watch, CSV, estimate) sees it as keyless up front, instead of accepting a scan that cannot run
  assert.equal(hasKey(db, 't2', OFF), false); assert.equal(hasKey(db, 't1', OFF), true)
  assert.equal(hasKey(db, 't2', { DAZL_PAID_VENDORS: 'openai' }), true)
  // the Db-layer read the watch, play, usage and estimate gates use (council round 2)
  assert.equal(await readHasKey(sqliteDb(db), 't2', OFF), false); assert.equal(await readHasKey(sqliteDb(db), 't1', OFF), true)
  assert.equal(usableVendor([{ vendor: 'openai' }, { vendor: 'anthropic' }], OFF)?.vendor, 'anthropic')
})
