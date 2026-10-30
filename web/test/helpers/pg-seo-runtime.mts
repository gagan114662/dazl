// Runs the SEO routes on a fresh Postgres schema with two tenants (see test/pg-seo.test.ts). Stubbed: the provider
// answers per key, the news page is local, no other network call is allowed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setUser } from './tenant-route-db.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { writeKey } from '../../lib/llm/key-store.ts'
import { createNewsjack } from '../../lib/seo/newsjack.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const BRIEF = 'TITLE OPTIONS\n1. a\n2. b\n3. c\nTARGET AUDIENCE\nfounders\nSEARCH INTENT\nlearn\nOUTLINE\n- one\n- two\n- three\nMETA DESCRIPTION\nd\nFAQS\nq1 q2 q3 and more text'
const DRAFT = 'TAKE\nthing happened and it matters because reasons.\nANGLE\na practical view from selling.\nTALKING POINTS\n- one\n- two\n- three'
const ARTICLE = `<html><head><title>Big CRM bought</title></head><body><p>${'News content here. '.repeat(30)}</p></body></html>`
const keysUsed: string[] = []
const stub = (async (u: unknown, init?: RequestInit) => {
  const url = String(u)
  if (url.startsWith('https://api.anthropic.com')) {
    const key = (init?.headers as Record<string, string>)['x-api-key']; keysUsed.push(key)
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
    const text = body.messages[0].content.includes('content brief') ? `${BRIEF} for ${key.slice(-6)}` : `${DRAFT} for ${key.slice(-6)}`
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
  }
  if (url.startsWith('https://news.example/')) return new Response(ARTICLE, { status: 200 })
  throw new Error(`Unexpected network call to ${url}`)
}) as typeof fetch
globalThis.fetch = stub

test('SEO routes on Postgres, two tenants', async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    setDb(db)
    await writeKey(db, A, 'anthropic', 'sk-ant-test-key-AAAAAA', master)
    await writeKey(db, B, 'anthropic', 'sk-ant-test-key-BBBBBB', master)
    const brief = await import('../../app/api/seo/brief/route.ts')
    const news = await import('../../app/api/seo/newsjack/route.ts')
    const { NextRequest } = await import('next/server')
    const post = (path: string, body: unknown) => new NextRequest(`https://app.dazl.test${path}`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test' } })
    const as = (t: string) => setUser({ id: t, business_name: t.slice(0, 1) })

    // briefs through the route: each on its own key
    as(A); const ba = await brief.POST(post('/api/seo/brief', { topic: 'SECRET-a-TOPIC' }))
    as(B); const bb = await brief.POST(post('/api/seo/brief', { topic: 'SECRET-b-TOPIC' }))
    assert.equal(ba.status, 200, await ba.clone().text()); assert.equal(bb.status, 200)
    assert.deepEqual(keysUsed, ['sk-ant-test-key-AAAAAA', 'sk-ant-test-key-BBBBBB'])
    // drafts (the route's article fetch resolves DNS, so the rows are made through the module with a stubbed lookup)
    const lookup = async () => [{ address: '93.184.216.34', family: 4 as const }]
    const na = await createNewsjack(db, A, 'https://news.example/a', { fetchImpl: stub, lookup, master })
    const nb = await createNewsjack(db, B, 'https://news.example/b', { fetchImpl: stub, lookup, master })
    assert.ok(!('error' in na) && !('error' in nb))

    // lists: own only
    as(A)
    const la = await (await brief.GET()).json() as { briefs: { topic: string; brief: string }[] }
    const ja = await (await news.GET()).json() as { newsjacks: { id: string; draft: string }[] }
    assert.deepEqual(la.briefs.map(x => x.topic), ['SECRET-a-TOPIC'])
    assert.ok(la.briefs[0].brief.endsWith('AAAAAA'))
    assert.deepEqual(ja.newsjacks.map(x => x.id), [na.id])
    assert.ok(!JSON.stringify({ la, ja }).includes('SECRET-b') && !JSON.stringify({ la, ja }).includes('BBBBBB') && !JSON.stringify(ja).includes(nb.id))
    // A approving B's draft: refused, B's draft unchanged
    const cross = await news.POST(post('/api/seo/newsjack', { action: 'approve', id: nb.id }))
    assert.equal(cross.status, 404)
    assert.equal((await db.get<{ status: string }>('SELECT status FROM newsjacks WHERE id = ?', [nb.id]))!.status, 'draft')
    // B approving its own: works
    as(B)
    assert.equal((await news.POST(post('/api/seo/newsjack', { action: 'approve', id: nb.id }))).status, 200)
    const lb = await (await brief.GET()).json() as { briefs: { topic: string }[] }
    assert.deepEqual(lb.briefs.map(x => x.topic), ['SECRET-b-TOPIC'])
    assert.equal((await db.get<{ status: string }>('SELECT status FROM newsjacks WHERE id = ?', [na.id]))!.status, 'draft', "A's draft untouched")
    console.log('PG_SEO ok')
  } finally { await db.close(); await s.drop() }
})
