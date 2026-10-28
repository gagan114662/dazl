// SEO audits, content briefs and newsjack drafts on the Db layer (docs/PLATFORM.md step 2), on SQLite and Postgres:
// each module's write and read paths, and two tenants kept apart (tenant B cannot list, approve or change A's rows).
// The tenant's AI key is read from the same store (each tenant's own); the provider and the audited site are stubbed.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { runAudit, recentAudits } from '../lib/seo/audit.ts'
import { generateBrief, recentBriefs } from '../lib/seo/brief.ts'
import { createNewsjack, approveNewsjack, recentNewsjacks } from '../lib/seo/newsjack.ts'
import { writeKey } from '../lib/llm/key-store.ts'
import type { Db } from '../lib/db/client.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'
import { bothEngines } from './helpers/engines.ts'

const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const master = randomBytes(32)
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const NOW = 1_800_000_000
const BRIEF = 'TITLE OPTIONS\n1. a\n2. b\n3. c\nTARGET AUDIENCE\nfounders\nSEARCH INTENT\nlearn\nOUTLINE\n- one\n- two\n- three\nMETA DESCRIPTION\nd\nFAQS\nq1 q2 q3 and more text'
const DRAFT = 'TAKE\nthing happened and it matters because reasons.\nANGLE\na practical view from selling.\nTALKING POINTS\n- one\n- two\n- three'
const ARTICLE = `<html><head><title>Big CRM bought</title></head><body><p>${'News content here. '.repeat(30)}</p></body></html>`
const HOME = '<html><head><title>Acme - Industrial Pipe</title><meta name="description" content="Acme makes industrial pipe for municipal water systems across North America."><link rel="canonical" href="https://acme.com/"></head><body><h1>Pipe</h1></body></html>'

// One stub for every outbound call: the audited site, the news page and the provider (which answers per tenant key).
const stub = (async (u: string, init?: RequestInit) => {
  if (u.startsWith('https://api.anthropic.com')) {
    const key = (init?.headers as Record<string, string>)['x-api-key']
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    const text = body.messages[0].content.includes('content brief') ? `${BRIEF} for ${key.slice(-6)}` : `${DRAFT} for ${key.slice(-6)}`
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
  }
  if (u === 'https://acme.com/' || u === 'https://beta.example/') return new Response(HOME, { status: 200 })
  if (u.startsWith('https://news.example/')) return new Response(ARTICLE, { status: 200 })
  return new Response('nf', { status: 404 })
}) as unknown as typeof fetch

// each tenant's own key, in the store under test
async function keys(db: Db): Promise<void> {
  await writeKey(db, A, 'anthropic', 'sk-ant-test-key-AAAAAA', master)
  await writeKey(db, B, 'anthropic', 'sk-ant-test-key-BBBBBB', master)
}

bothEngines('SEO audits: stored per tenant; each tenant lists only its own', async ({ db }) => {
  const a = await runAudit(db, A, 'acme.com', { fetchImpl: stub, lookup: pubLookup, now: NOW, id: 'audit-a' })
  const b = await runAudit(db, B, 'beta.example', { fetchImpl: stub, lookup: pubLookup, now: NOW + 1, id: 'audit-b' })
  assert.ok('checks' in a && 'checks' in b)
  const la = await recentAudits(db, A), lb = await recentAudits(db, B)
  assert.deepEqual(la.map(r => [r.id, r.domain, r.created_at]), [['audit-a', 'acme.com', NOW]])
  assert.deepEqual(lb.map(r => [r.id, r.domain]), [['audit-b', 'beta.example']])
  assert.equal(la[0].results.checks.find(c => c.id === 'title')?.ok, true) // results round-trip as JSON
  assert.deepEqual(await recentAudits(db, 'c'.repeat(32)), [])
})

bothEngines("briefs: generated on each tenant's own key, stored per tenant; B never sees A's", async ({ db }) => {
  await keys(db)
  const a = await generateBrief(db, A, 'lead generation', { fetchImpl: stub, master, now: NOW })
  const b = await generateBrief(db, B, 'pipe sales', { fetchImpl: stub, master, now: NOW })
  assert.ok(!('error' in a) && !('error' in b))
  const la = await recentBriefs(db, A), lb = await recentBriefs(db, B)
  assert.deepEqual(la.map(r => r.topic), ['lead generation'])
  assert.deepEqual(lb.map(r => r.topic), ['pipe sales'])
  assert.ok(la[0].brief.endsWith('AAAAAA') && lb[0].brief.endsWith('BBBBBB')) // each on its own key
  assert.equal(typeof la[0].created_at, 'number')
})

bothEngines("newsjacks: B cannot list or approve A's draft; A's approval works once", async ({ db }) => {
  await keys(db)
  const a = await createNewsjack(db, A, 'https://news.example/a', { fetchImpl: stub, lookup: pubLookup, master, now: NOW })
  const b = await createNewsjack(db, B, 'https://news.example/b', { fetchImpl: stub, lookup: pubLookup, master, now: NOW })
  assert.ok(!('error' in a) && !('error' in b))
  if ('error' in a || 'error' in b) return
  assert.deepEqual((await recentNewsjacks(db, B)).map(r => r.id), [b.id])
  assert.equal(await approveNewsjack(db, B, a.id), false) // B, with A's id
  assert.equal((await recentNewsjacks(db, A))[0].status, 'draft') // A's row unchanged
  assert.equal(await approveNewsjack(db, A, a.id), true)
  assert.equal(await approveNewsjack(db, A, a.id), false) // only once
  assert.deepEqual((await recentNewsjacks(db, A)).map(r => [r.id, r.status]), [[a.id, 'approved']])
  assert.deepEqual((await recentNewsjacks(db, B)).map(r => [r.id, r.status]), [[b.id, 'draft']])
})
