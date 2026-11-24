import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateKeys } from '../lib/llm/key-store.ts'
import { pickVendor } from '../lib/scan/runner.ts'

// #1665 (Breken QA, 2026-11-23): with OpenAI switched off (DAZL_PAID_VENDORS does not name it), a workspace whose NEWEST saved key
// is an OpenAI key still had OpenAI picked by pickVendor, so the website profile scan, previewIcp, user-funded scans, follow-up step
// text and both qualify routes called OpenAI. pickVendor is the one place those six paths ask "which vendor"; it must apply the gate.
function keys(rows: [tenant: string, vendor: string, createdAt: number][]) {
  const db = new Database(':memory:')
  migrateKeys(db)
  const ins = db.prepare('INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at, created_at) VALUES (?, ?, ?, ?, 1, ?)')
  for (const [t, v, at] of rows) ins.run(t, v, 'x', '1234', at)
  return db
}

function withPaidVendors<T>(value: string | undefined, run: () => T): T {
  const before = process.env.DAZL_PAID_VENDORS
  if (value === undefined) delete process.env.DAZL_PAID_VENDORS
  else process.env.DAZL_PAID_VENDORS = value
  try { return run() } finally {
    if (before === undefined) delete process.env.DAZL_PAID_VENDORS
    else process.env.DAZL_PAID_VENDORS = before
  }
}

test('#1665 pickVendor: OpenAI switched off, a newer OpenAI key beside an Anthropic key picks Anthropic', () => {
  const db = keys([['A', 'anthropic', 100], ['A', 'openai', 200]])
  assert.equal(withPaidVendors(undefined, () => pickVendor(db, 'A')), 'anthropic')
  assert.equal(withPaidVendors('apollo,pdl', () => pickVendor(db, 'A')), 'anthropic')
})

test('#1665 pickVendor: OpenAI switched off, a workspace with only an OpenAI key has no usable vendor', () => {
  const db = keys([['B', 'openai', 200]])
  assert.equal(withPaidVendors(undefined, () => pickVendor(db, 'B')), null)
})

test('#1665 pickVendor: the operator naming openai keeps the newest key, and another workspace\'s keys never count', () => {
  const db = keys([['A', 'anthropic', 100], ['A', 'openai', 200], ['C', 'anthropic', 300]])
  assert.equal(withPaidVendors('openai', () => pickVendor(db, 'A')), 'openai')
  assert.equal(withPaidVendors(undefined, () => pickVendor(db, 'none')), null)
})
