// Route-boundary regression for #874 (review round 6): POST /api/scan with a valid LONG profile whose flat JSON fits the budget but leaves no room for even the smallest hold record must refuse
// (400 holds_too_large) BEFORE anything is queued or written: no job, no stored profile or decision change. Ordinary no-hold and roomy-hold profiles still succeed. No runner, network or provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { setAuthDb } from './scan-route-auth-db.ts'
import { sqliteDb, setDb } from '../../lib/db/client.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateSpendPools } from '../../lib/llm/spend-pool.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { providers } from '../../lib/llm/provider.ts'
import { buildResearch, toStored } from '../../lib/scan/seller-research.ts'
import { holdNameOf } from '../../lib/scan/offer-identity.ts'
import { ICP_JSON_BUDGET, normalizeIcp, type Icp, type IcpResearch } from '../../lib/scan/icp.ts'
import { POST } from '../../app/api/scan/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
for (const [, p] of Object.entries(providers)) { if (p.complete) p.complete = async () => { throw new Error('Unexpected provider call') } }
globalThis.fetch = (async (url: unknown) => { throw new Error(`Unexpected network call to ${String(url)}`) }) as typeof fetch
const request = (body: unknown) => new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const PAGES = [{ url: 'https://seller.example/', kind: 'product' as const, title: 'Alpha', text: 'Alpha helps practice managers fill their appointment book.', fetched_at: 1 }]
const NAME = 'Alpha'
// A stored research with ONE unresolved (held) decision for Alpha: the review requirement a save must never lose.
const heldResearch = (): IcpResearch => {
  const r = buildResearch({ offers: [{ id: 'o1', name: NAME }], items: [{ offer: 'o1', kind: 'persona', text: 'practice managers', url: PAGES[0].url, quote: 'helps practice managers fill their appointment book', inferred: false }] }, PAGES, 'seller.example')
  if ('error' in r) throw new Error('fixture')
  return toStored({ ...r, unresolved: [{ names: [holdNameOf(NAME)], kind: 'persona', text: 'office managers', status: 'rejected' }] })
}
const noHoldResearch = (): IcpResearch => { const { u: _u, ...rest } = heldResearch(); void _u; return rest }
// The valid long profile: exactly the field caps normalizeIcp keeps (summary 300; who 6x160; industries 6x160; sizes 4x160; where 5x160; signals/exclude empty).
const A = (n: number, tag: string) => `${tag}${'x'.repeat(n - tag.length)}`
const longFlat = () => ({ summary: A(300, 's'), who: Array.from({ length: 6 }, (_, i) => A(160, `w${i}`)), industries: Array.from({ length: 6 }, (_, i) => A(160, `i${i}`)), sizes: Array.from({ length: 4 }, (_, i) => A(160, `z${i}`)), where: Array.from({ length: 5 }, (_, i) => A(160, `r${i}`)), signals: [] as string[], exclude: [] as string[] })
const shortFlat = () => ({ summary: 'Dental practices that need booking software.', who: ['practice managers'], industries: [] as string[], sizes: [] as string[], where: [] as string[], signals: [] as string[], exclude: [] as string[] })
const withResearch = (flat: ReturnType<typeof longFlat>, research: IcpResearch | undefined): Icp => ({ ...flat, ...(research ? { research } : {}) }) as Icp

// every table except the rate limiter's own bookkeeping (it counts the request itself, before any decision is made)
const dump = (db: Database.Database) => {
  const out: Record<string, unknown[]> = {}
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
    if (/rate|limit/i.test(name)) continue
    out[name] = db.prepare(`SELECT * FROM "${name}"`).all()
  }
  return JSON.stringify(out)
}
const jobs = (db: Database.Database) => (db.prepare('SELECT COUNT(*) AS n FROM scan_jobs').get() as { n: number }).n
const storedIcp = (db: Database.Database, id: string) => JSON.parse((db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(id) as { icp: string }).icp) as Icp
const done = (db: Database.Database) => { db.prepare("UPDATE scan_jobs SET status = 'running' WHERE status = 'pending'").run(); db.prepare("UPDATE scan_jobs SET status = 'done' WHERE status = 'running'").run() }

test('#874 scan route: a valid long profile whose holds cannot fit is refused (400 holds_too_large) with no job and no stored change; no-hold and roomy-hold controls succeed', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); migrateMemory(db); migrateKeys(db); migratePlans(db); migrateSpendPools(db); migratePlatform(db)
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, sells TEXT, website TEXT)')
    db.prepare("INSERT INTO users (id, email, sells, website) VALUES ('A', 'a@example.test', 'Alpha', 'seller.example')").run()
    saveKey(db, 'A', 'anthropic', 'sk-ant...-key')
    setScanDb(db); setAuthDb(db); setDb(sqliteDb(db))

    // --- fixture truth: the long profile is VALID (survives normalization whole), the flat JSON fits, and the minimal hold record does not fit in what is left
    const longIcp = withResearch(longFlat(), heldResearch())
    const norm = normalizeIcp(JSON.parse(JSON.stringify(longIcp)))!
    const flat = (i: Icp) => { const { research: _r, ...f } = i; void _r; return JSON.stringify(f).length }
    assert.equal(flat(norm), flat(longIcp), 'normalization keeps every field of the long profile (nothing was stripped to make it fit)')
    assert.ok(flat(norm) <= ICP_JSON_BUDGET, 'flat JSON fits the budget')
    const minimalHold = JSON.stringify({ v: 1, site: 'https://seller.example', offers: [{ i: 'alpha', n: 'Alpha' }], hyps: [], q: null, ans: null, u: [{ n: ['alpha'], k: 'persona', t: '', s: 'reviewed', w: true, o: true }] }).length
    assert.ok(ICP_JSON_BUDGET - flat(norm) - 16 < minimalHold, `the smallest hold record (${minimalHold}) does not fit in the room left (${ICP_JSON_BUDGET - flat(norm) - 16})`)

    // --- prior stored state: a roomy profile WITH the hold is saved by the route (control: roomy-hold succeeds and keeps the hold)
    const roomy = await POST(request({ query: 'dental practices in Ohio hiring front desk', offer: NAME, icp: withResearch(shortFlat() as never, heldResearch()) }))
    const roomyBody = await roomy.json() as { job_id?: string; error?: string }
    assert.equal(roomy.status, 202, JSON.stringify(roomyBody))
    const prior = storedIcp(db, roomyBody.job_id!)
    assert.ok((prior.research?.u ?? []).length > 0 && prior.research!.u!.some(u => u.n.includes('alpha')), 'roomy profile: the hold is stored')
    done(db)

    // --- the refusal: no job, no change to ANY stored table (profile, decisions, offers)
    const beforeJobs = jobs(db), beforeDump = dump(db)
    const refused = await POST(request({ query: 'dental practices in Ohio hiring front desk', offer: NAME, icp: longIcp }))
    const refusedBody = await refused.json() as { error?: string; message?: string; job_id?: string }
    assert.equal(refused.status, 400, JSON.stringify(refusedBody))
    assert.equal(refusedBody.error, 'holds_too_large'); assert.ok(refusedBody.message && !refusedBody.job_id)
    assert.equal(jobs(db), beforeJobs, 'no job was created')
    assert.equal(dump(db), beforeDump, 'nothing stored changed: profile, decisions and every other table are byte-identical')
    assert.deepEqual(storedIcp(db, roomyBody.job_id!), prior, 'the prior stored profile and its holds are exactly as they were')

    // --- control: the SAME long profile without any hold is an ordinary success (research that cannot fit is omitted, as before)
    const plain = await POST(request({ query: 'dental practices in Ohio hiring front desk', offer: NAME, icp: withResearch(longFlat(), noHoldResearch()) }))
    const plainBody = await plain.json() as { job_id?: string; error?: string }
    assert.equal(plain.status, 202, JSON.stringify(plainBody)); assert.equal(jobs(db), beforeJobs + 1)
    assert.equal(storedIcp(db, plainBody.job_id!).who.length, 6, 'the long profile was stored whole')
    // and with no research at all
    done(db)
    const bare = await POST(request({ query: 'dental practices in Ohio hiring front desk', offer: NAME, icp: withResearch(longFlat(), undefined) }))
    assert.equal(bare.status, 202, 'no research: success')
  } finally { db.close() }
})
