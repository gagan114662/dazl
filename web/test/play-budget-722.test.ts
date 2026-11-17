// Refs #722 (part of #363): one shared per-play budget. A play's run_budget.max_usd already bounds its scan's model calls
// (scan_jobs.spend_reserved_usd). This slice makes the draft polish and the follow-up text for that play's leads charge
// against the SAME figure: each call reserves its worst case on the play's row before it runs, and a call that would
// pass max_usd is refused before any provider request (the template stays). Synthetic data only, no provider, $0.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { createDraft, saveSettings } from '../lib/outreach/service.ts'
import { polishDraft, llmFollowupText } from '../lib/outreach/draft-llm.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import type { Provider } from '../lib/llm/provider.ts'

const OFFER = 'Dental appointment software'
const master = randomBytes(32)
function setup(runBudget: string | null, reserved: number | null) {
  const raw = new Database(':memory:')
  migrateScan(raw); migrateOutreach(raw); migrateConnectors(raw); migrateKeys(raw); migratePlans(raw); migrateMemory(raw)
  raw.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sells TEXT, website TEXT)')
  raw.prepare('INSERT INTO users VALUES (?, ?, ?)').run('A', OFFER, 'https://seller.example')
  saveMemory(raw, 'A', { positioning: OFFER })
  saveKey(raw, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveSettings(raw, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  raw.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller,offer,run_budget,spend_reserved_usd) VALUES('play','A','Request','test','London','done','London startups',?,?,?,?)").run(OFFER, OFFER, runBudget, reserved)
  raw.prepare("INSERT INTO leads(id,scan_job_id,name,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from,event_date) VALUES('lead-play','play','Pat','Buyer','sales@buyer.invalid','Buyer is hiring an SDR','https://buyer.invalid/careers','Buyer is hiring an SDR',70,1800000000,'test_review',?)").run(new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10))
  return raw
}
function fake(model: string | undefined) {
  const calls = { n: 0 }
  const p = {
    ...(model ? { configuredModel: () => model } : {}),
    complete: async () => { calls.n++; return 'Just checking whether a short call next week makes sense for you.\n\nThanks,' },
    completeDetailed: async () => { calls.n++; return { text: 'Subject: Your SDR hiring\n\nI saw the SDR posting reported on your careers page. Would a short call make sense?\n\nThanks,', model: model ?? 'x' } },
  }
  return { calls, providers: { anthropic: p } as unknown as Record<string, Provider> }
}
const reserved = (raw: Database.Database) => (raw.prepare("SELECT spend_reserved_usd r FROM scan_jobs WHERE id = 'play'").get() as { r: number | null }).r
const lead = { company: 'Buyer', name: 'Pat', signal: 'Buyer is hiring an SDR', source_url: 'https://buyer.invalid/careers', lead_id: 'lead-play' }

test('AC-1 polish: a play whose scan already used its max_usd refuses the rewrite before any provider call', async () => {
  const raw = setup(JSON.stringify({ max_usd: 0.05 }), 0.0499)
  try {
    const id = createDraft(raw, 'A', 'lead-play', 'Acme')
    const f = fake('claude-haiku-4-5')
    const r = await polishDraft(raw, 'A', id, 'Acme', { master, providers: f.providers })
    assert.deepEqual(r, { rewritten: false, reason: 'play_budget' })
    assert.equal(f.calls.n, 0, 'no provider call')
    assert.equal(reserved(raw), 0.0499, 'nothing reserved')
    assert.equal((raw.prepare('SELECT outcome FROM outreach_llm_usage ORDER BY id DESC LIMIT 1').get() as { outcome: string }).outcome, 'play_budget')
  } finally { raw.close() }
})

test('AC-2 polish: under the play budget it runs and its worst case is charged to the same play total', async () => {
  const raw = setup(JSON.stringify({ max_usd: 0.05 }), 0.01)
  try {
    const id = createDraft(raw, 'A', 'lead-play', 'Acme')
    const f = fake('claude-haiku-4-5')
    const r = await polishDraft(raw, 'A', id, 'Acme', { master, providers: f.providers })
    assert.equal(r.rewritten, true)
    assert.equal(f.calls.n, 1)
    const after = reserved(raw)!
    assert.ok(after > 0.01 && after <= 0.05, `charged to the play: ${after}`)
  } finally { raw.close() }
})

test('AC-3 follow-up: over the play budget the model is not called and the template is used (null)', async () => {
  const raw = setup(JSON.stringify({ max_usd: 0.05 }), 0.0499)
  try {
    const f = fake('claude-haiku-4-5')
    assert.equal(await llmFollowupText(raw, 'A', 0, lead, 'Acme', null, { master, providers: f.providers }), null)
    assert.equal(f.calls.n, 0)
    assert.equal(reserved(raw), 0.0499)
  } finally { raw.close() }
})

test('AC-3 follow-up: under the play budget it runs and is charged to the play', async () => {
  const raw = setup(JSON.stringify({ max_usd: 0.05 }), 0)
  try {
    const f = fake('claude-haiku-4-5')
    assert.ok(await llmFollowupText(raw, 'A', 0, lead, 'Acme', null, { master, providers: f.providers }))
    assert.equal(f.calls.n, 1)
    assert.ok(reserved(raw)! > 0)
  } finally { raw.close() }
})

test('AC-4 an unpriced model under a play max_usd fails closed; a play without max_usd is unchanged', async () => {
  const capped = setup(JSON.stringify({ max_usd: 0.05 }), 0)
  try {
    const f = fake(undefined)
    assert.equal(await llmFollowupText(capped, 'A', 0, lead, 'Acme', null, { master, providers: f.providers }), null)
    assert.equal(f.calls.n, 0)
  } finally { capped.close() }
  const open = setup(null, null)
  try {
    const f = fake(undefined)
    assert.ok(await llmFollowupText(open, 'A', 0, lead, 'Acme', null, { master, providers: f.providers }))
    assert.equal(f.calls.n, 1)
    assert.equal(reserved(open), null, 'no play budget: nothing charged to the play')
  } finally { open.close() }
})
