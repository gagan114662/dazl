// Inventory of paid model calls outside the scan transports (#850, sibling of #848's scan inventory): every module in
// lib/ and app/ that calls a provider's complete / completeDetailed / research is classified, and each entry point
// outside a scan wraps the provider in the owner's spend guard before calling. A new, unclassified call site fails.
// Behavioral proof for the two entry points no other test refuses (SEO newsjack, sequence follow-ups): past the
// owner's limit no provider call is made. Synthetic tenant and key; stub fetch; nothing is billed or sent.
// Out of scope here: raw vendor HTTP outside a Provider (lib/evals/judge-validation-run.ts, the operator's claim-gated
// eval) is inventoried by #848's endpoint test (scan-spend-cap-paths, CLAIM_GATED).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createNewsjack } from '../lib/seo/newsjack.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'
import { saveSettings, createDraft } from '../lib/outreach/service.ts'
import { createSequence, draftSequenceSteps, sequenceStepText } from '../lib/outreach/sequences.ts'
import { saveMemory } from '../lib/memory.ts'

const ROOT = join(import.meta.dirname, '..')

// Entry points outside a scan: must call the owner guard on the provider they call.
const OWNER_ENTRY = [
  'lib/outreach/draft-llm.ts', 'lib/outreach/sequences.ts', 'lib/replies/threads.ts',
  'lib/seo/brief.ts', 'lib/seo/newsjack.ts', 'lib/scan/icp-from-site.ts',
]
// Called only with a provider its one caller already guarded: [module, its exported function, that caller, the guarded call].
const GUARDED_BY_CALLER: [string, string, string, RegExp][] = [
  ['lib/scan/lead-qualify.ts', 'qualifyLead', 'lib/scan/qualify-run.ts', /qualifyLead\(ownerGuarded\(/],
  ['lib/scan/icp.ts', 'inferIcp', 'lib/scan/runner.ts', /inferIcp\(providers_\[vendor\]/],
]
// Scan work: the runner's providers are guarded per job and reserved on the scan cap (#848, scan-spend-cap-paths).
const SCAN = ['lib/scan/runner.ts', 'lib/scan/buyer-fit.ts', 'lib/scan/score.ts']
// Provider wrappers (decorate a provider, add no call of their own) and the guard itself.
const WRAPPERS = ['lib/evals/trace.ts', 'lib/outreach/launch-policy.ts', 'lib/scan/model-usage.ts']
// `.complete(token)` on a job queue, not a model.
const NOT_MODEL = ['lib/queue/scan-claimer.ts', 'lib/scan/queue-runner.ts']

// A direct call, an aliased method (`const complete = provider.complete`), `.complete.call(` and `.complete?.(`.
const CALL = /\.(complete|completeDetailed|research)!?\(|=\s*\w+\.(complete|completeDetailed)\s*(;|$)|\.(complete|completeDetailed|research)\??\.(call|apply)\(|\.(complete|completeDetailed|research)\?\.\(/m
function sources(dir: string): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...sources(p)); continue }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') })
  }
  return out
}
const SOURCES = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))]
const KNOWN = new Set([...OWNER_ENTRY, ...GUARDED_BY_CALLER.map(g => g[0]), ...SCAN, ...WRAPPERS, ...NOT_MODEL])

function unclassified(srcs: { rel: string; text: string }[]): string[] {
  return srcs.filter(s => !s.rel.startsWith('lib/llm/') && CALL.test(s.text) && !KNOWN.has(s.rel)).map(s => s.rel)
}

test('#850 inventory: every module calling a model provider outside lib/llm is classified', () => {
  assert.deepEqual(unclassified(SOURCES), [], 'a new paid model call site: an entry point must wrap its provider with ownerGuarded before calling')
})

test('#850 inventory: an unexpected new call site is caught in every call shape (the check is not vacuous)', () => {
  const shapes = ['await provider.complete(key, prompt, f, 500)', 'const complete = provider.complete\nawait complete.call(provider, k, p)', 'await provider.completeDetailed?.(k, p)', 'return p.research.call(p, k, q)']
  for (const text of shapes) assert.deepEqual(unclassified([{ rel: 'lib/outreach/new-ai-feature.ts', text }]), ['lib/outreach/new-ai-feature.ts'], text)
})

test('#850 inventory: each owner entry point guards the provider it calls, and each guarded-by-caller module has that one guarded caller', () => {
  for (const rel of OWNER_ENTRY) {
    const src = SOURCES.find(s => s.rel === rel)?.text
    assert.ok(src, `${rel} exists`)
    assert.match(src!, /ownerGuarded\(|guardProvider\(/, `${rel} reserves through the owner guard before its paid call`)
  }
  for (const [rel, fn, caller, guard] of GUARDED_BY_CALLER) {
    assert.ok(SOURCES.some(s => s.rel === rel), `${rel} exists`)
    assert.match(SOURCES.find(s => s.rel === caller)!.text, guard, `${caller} guards the provider it hands to ${rel}`)
    // Any import path that ends in the module (relative, '@/lib/...', with or without .ts), and a call of its function.
    const base = rel.split('/').pop()!.replace(/\.ts$/, '')
    const imports = new RegExp(`from\\s+['"][^'"]*/${base}(\\.ts)?['"]`)
    const callers = SOURCES.filter(s => s.rel !== rel && imports.test(s.text) && new RegExp(`\\b${fn}\\(`).test(s.text)).map(s => s.rel)
    assert.deepEqual(callers, [caller], `${fn} (${rel}) is called only from ${caller}`)
  }
})

// ---- behaviour: the two entry points no other test refuses ----

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const LIMIT = { DAZL_RUN_MAX_USD_USERS: 'A:0.0001', DAZL_OWNER_MONTH_MAX_USD_USERS: undefined, DAZL_ANTHROPIC_MODEL: undefined }
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const ARTICLE = `<html><head><title>Big CRM bought by MegaCorp</title></head><body><p>${'News content here. '.repeat(30)}</p></body></html>`
const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]

test('#850: SEO newsjack past the owner limit is refused with no model call', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  let modelCalls = 0
  const f = (async (u: string) => {
    if (String(u).includes('anthropic.com')) { modelCalls++; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(200) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }) }
    return new Response(ARTICLE, { status: 200 })
  }) as unknown as typeof fetch
  await withEnv(LIMIT, async () => {
    assert.deepEqual(await createNewsjack(sqliteDb(db), 'A', 'https://news.example/story', { fetchImpl: f, lookup: pubLookup, master }), { error: 'spend_limit' })
  })
  assert.equal(modelCalls, 0)
})

test('#850: sequence follow-up steps past the owner limit make no model call and keep the template text', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  saveMemory(db, 'A', { positioning: 'software that ramps new sales hires' })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.example', 'hiring AEs', 'https://n.example/a', 'quote', 80, 1800000000, 'test_review')").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const msg = createDraft(db, 'A', 'l1', 'Acme')
  const seq = createSequence(db, 'A', msg, { businessName: 'Acme' })
  let modelCalls = 0
  const f = (async () => { modelCalls++; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi Pat, a quick nudge about the AE hiring. Worth a short call?\n\nThanks,' }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }) }) as unknown as typeof fetch
  await withEnv(LIMIT, () => draftSequenceSteps(db, 'A', seq, 'Acme', { fetchImpl: f, master }))
  assert.equal(modelCalls, 0)
  const lead = { company: 'Acme', name: 'Pat', signal: 'hiring AEs', source_url: 'https://n.example/a' }
  const bodies = db.prepare('SELECT step, body FROM sequence_steps WHERE sequence_id = ? AND step > 1 ORDER BY step').all(seq) as { step: 2 | 3; body: string }[]
  assert.deepEqual(bodies.map(b => b.body), bodies.map(b => sequenceStepText(b.step, lead, 'Acme', null)))
})
