// Regression tests for the F1/F2/F4/F5 fixes (docs/security/tenant-isolation-assessment.md,
// docs/security/ssrf-remediation-proposal.md). These prove the CALLERS route through the
// SSRF guard - not just that the guard itself works (isolation-ssrf-guard.test.ts covers that).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { toCsv } from '../lib/scan/csv.ts'
import { migrateSeo, normalizeDomain, runAudit } from '../lib/seo/audit.ts'
import { createNewsjack, migrateNewsjacks } from '../lib/seo/newsjack.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { pushLead } from '../lib/crm/index.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'

const master = randomBytes(32)
const META = '169.254.169.254'
// Everything resolves to the cloud-metadata address: any real fetch would be an SSRF hit.
const hostileLookup: Lookup = async () => [{ address: META, family: 4 }]
const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]

// ---------- F1: CSV formula injection ----------

test('csv: formula-leading cells are forced to literal text', () => {
  const cols = [{ key: 'a', label: 'A' }]
  const csv = toCsv([
    { a: '=HYPERLINK("https://evil.example","x")' },
    { a: '+1+1' },
    { a: '-2+3' },
    { a: '@SUM(A1)' },
    { a: '\t=1+1' },
    { a: 'Acme Corp' },
    { a: 42 },
    { a: null },
  ], cols).replace(/^﻿/, '')
  const rows = csv.split('\r\n')
  // The dangerous cell is quoted (it contains commas); inside the quotes it starts with '.
  assert.equal(rows[1], `"'=HYPERLINK(""https://evil.example"",""x"")"`)
  assert.equal(rows[2], "'+1+1")
  assert.equal(rows[3], "'-2+3")
  assert.equal(rows[4], "'@SUM(A1)")
  assert.equal(rows[5], "'\t=1+1")
  assert.equal(rows[6], 'Acme Corp')
  assert.equal(rows[7], '42')
  assert.equal(rows[8], '')
})

// ---------- F4: SEO audit goes through the guard ----------

test('audit: localhost is no longer a valid domain', () => {
  assert.equal(normalizeDomain('localhost'), null)
  assert.equal(normalizeDomain('http://localhost:3100/'), null)
  assert.equal(normalizeDomain('acme.com'), 'acme.com')
})

test('audit: a domain resolving to a non-public address is refused before any request', async () => {
  const db = new Database(':memory:')
  migrateSeo(db)
  let fetched = 0
  const f = (async () => { fetched++; return new Response('<html></html>', { status: 200 }) }) as unknown as typeof fetch
  const r = await runAudit(db, 'A', 'internal.example', { fetchImpl: f, lookup: hostileLookup })
  assert.deepEqual(r, { error: 'That domain does not resolve to a public address.' })
  assert.equal(fetched, 0, 'no request left the server')
})

test('audit: a redirect hopping to a private host is blocked at the hop', async () => {
  const db = new Database(':memory:')
  migrateSeo(db)
  const seen: string[] = []
  const f = (async (u: string | URL | Request) => {
    seen.push(String(u))
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
  }) as unknown as typeof fetch
  // First hop resolves publicly; the redirect target is a literal metadata IP.
  const r = await runAudit(db, 'A', 'acme.com', { fetchImpl: f, lookup: pubLookup })
  assert.deepEqual(r, { error: 'That domain does not resolve to a public address.' })
  assert.deepEqual(seen, ['https://acme.com/'], 'the private hop was never requested')
})

// ---------- F4: newsjack goes through the guard ----------

test('newsjack: a pasted URL resolving to a non-public address is never fetched', async () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  migrateNewsjacks(db)
  saveKey(db, 'u1', 'anthropic', 'sk-ant-test-1234', master)
  let fetched = 0
  const f = (async () => { fetched++; return new Response('<html></html>', { status: 200 }) }) as unknown as typeof fetch
  const r = await createNewsjack(db, 'u1', 'https://internal.example/story', { fetchImpl: f, lookup: hostileLookup, master })
  assert.deepEqual(r, { error: 'fetch' })
  assert.equal(fetched, 0, 'article request never left the server')
})

// ---------- F5: CRM webhook goes through the guard at push time ----------

test('crm webhook: a saved URL re-pointed at a private address is blocked at push time', async () => {
  let fetched = 0
  const f = (async () => { fetched++; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
  // Saved while public (save-time check would pass); DNS re-pointed before the push.
  await assert.rejects(
    () => pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, { company: 'Acme', name: 'Ada', contact: 'ada@acme.example', signal: 's', source_url: 'https://x.com/1' }, f, { lookup: hostileLookup }),
    /Webhook address is not public/,
  )
  assert.equal(fetched, 0, 'no POST left the server')
})

test('crm webhook: a redirecting webhook is reported, not followed to a private host', async () => {
  const seen: string[] = []
  const f = (async (u: string | URL | Request) => {
    seen.push(String(u))
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/hook' } })
  }) as unknown as typeof fetch
  await assert.rejects(
    () => pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, { company: 'Acme', name: 'Ada', contact: null, signal: 's', source_url: 'https://x.com/1' }, f, { lookup: pubLookup }),
    /Webhook address is not public/, // the redirect target is validated before any second request
  )
  assert.deepEqual(seen, ['https://hooks.example/dazl'], 'the private redirect target was never requested')
})
