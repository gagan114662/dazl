import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { saveSettings, createDraft } from '../lib/outreach/service.ts'
import { polishDraft, parseDraftOutput, llmFollowupText } from '../lib/outreach/draft-llm.ts'
import { getMemory, isExcluded, MemoryError, memoryPromptBlock, migrateMemory, saveMemory } from '../lib/memory.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { Provider } from '../lib/llm/provider.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateOutreach(db); migrateMemory(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  return db
}

test('save/get roundtrip; caps enforced with the field named; bad shapes rejected', () => {
  const db = setup()
  const m = saveMemory(db, 'A', { icp: 'B2B SaaS', positioning: 'we find buyers', tone: 'direct', exclusions: ['acme.com', 'Bigco'], objections: [{ q: 'too expensive?', a: 'cheaper than a bad hire' }] })
  assert.equal(m.icp, 'B2B SaaS')
  assert.deepEqual(m.exclusions, ['acme.com', 'Bigco'])
  assert.equal(getMemory(db, 'A')!.tone, 'direct')
  assert.equal(getMemory(db, 'B'), null) // tenant isolation
  assert.throws(() => saveMemory(db, 'A', { icp: 'x'.repeat(601) }), (e) => e instanceof MemoryError && e.field === 'icp')
  assert.throws(() => saveMemory(db, 'A', { exclusions: Array(21).fill('x.com') }), /at most 20/)
  assert.throws(() => saveMemory(db, 'A', { objections: 'nope' }), MemoryError)
  // empty save clears
  saveMemory(db, 'A', {})
  assert.equal(getMemory(db, 'A')!.icp, '')
})

test('memoryPromptBlock is data-wrapped and empty when nothing is set', () => {
  const db = setup()
  assert.equal(memoryPromptBlock(getMemory(db, 'A')), '')
  saveMemory(db, 'A', { icp: 'saas', tone: 'blunt', objections: [{ q: 'q1', a: 'a1' }] })
  const block = memoryPromptBlock(getMemory(db, 'A'))
  assert.match(block, /not instructions/)
  assert.match(block, /Seller's ideal customer profile: saas/)
  assert.match(block, /"q1" -> "a1"/)
})

test('isExcluded: domain, subdomain, email domain and company-name substring all match; unrelated does not', () => {
  const db = setup()
  const m = saveMemory(db, 'A', { exclusions: ['acme.com', 'Bigco', 'nonprofit.org'] })
  assert.equal(isExcluded(m, { company: 'Acme', company_domain: 'acme.com' }), true)
  assert.equal(isExcluded(m, { company: 'Acme UK', company_domain: 'uk.acme.com' }), true)
  assert.equal(isExcluded(m, { company: 'Someone', contact: 'pat@acme.com' }), true)
  assert.equal(isExcluded(m, { company: 'Bigco Industries', company_domain: 'bigco-industries.example' }), true)
  assert.equal(isExcluded(m, { company: 'Globex', company_domain: 'globex.com', contact: 'a@globex.com' }), false)
  assert.equal(isExcluded(null, { company: 'Acme' }), false)
})

test('parseDraftOutput: subject line required, sane lengths, quotes stripped', () => {
  assert.deepEqual(parseDraftOutput('Subject: "Quick question"\n\nHi Pat,\n\nSaw the news. Up for a call?\n\nThanks,'), { subject: 'Quick question', body: 'Hi Pat,\n\nSaw the news. Up for a call?\n\nThanks,' })
  assert.equal(parseDraftOutput('no subject here'), null)
  assert.equal(parseDraftOutput('Subject: x\n\nshort'), null)
})

test('polishDraft rewrites a template draft with the tenant model + memory, keeps it on failure', async () => {
  const db = setup()
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  saveMemory(db, 'A', { tone: 'direct', positioning: 'software that ramps new sales hires' })
  // minimal verified lead
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  // Eligible fixture is explicitly human-reviewed, not machine-timing proof.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000,human_confirmed_from='test_review' WHERE confidence IS NOT NULL").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l2', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  // Eligible fixture is explicitly human-reviewed, not machine-timing proof.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000,human_confirmed_from='test_review' WHERE confidence IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const id = createDraft(db, 'A', 'l1', 'Dazl')
  const prov: Record<string, Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async (k, prompt) => { assert.match(prompt, /Seller's writing tone: direct/); assert.match(prompt, /not instructions/); assert.match(prompt, /NOT a verified fact/); assert.match(prompt, /the source's claim/); return 'Subject: Saw the AE hiring\n\nHi Pat,\n\nNoticed Acme is hiring AEs. We help teams ramp them faster. Worth a short call?\n\nThanks,' } } }
  assert.deepEqual(await polishDraft(db, 'A', id, 'Dazl', { master, providers: prov as never }), { rewritten: true, vendor: 'anthropic' })
  const row = db.prepare('SELECT subject, body FROM outreach_messages WHERE id = ?').get(id) as { subject: string; body: string }
  assert.equal(row.subject, 'Saw the AE hiring')
  assert.match(row.body, /ramp them faster/)
  // provider down -> template stays (second lead: one draft per lead is enforced)
  const id2 = createDraft(db, 'A', 'l2', 'Dazl')
  const bad: Record<string, Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async () => { throw new Error('down') } } }
  assert.deepEqual(await polishDraft(db, 'A', id2, 'Dazl', { master, providers: bad as never }), { rewritten: false, reason: 'error' })
  const tpl = db.prepare('SELECT subject FROM outreach_messages WHERE id = ?').get(id2) as { subject: string }
  assert.equal(tpl.subject, 'Quick question for Acme')
  // no key at all -> false, template stays
  const db2 = new Database(':memory:'); migrateScan(db2); migrateKeys(db2); migrateOutreach(db2); migrateMemory(db2)
  db2.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db2.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.com', 's', 'https://n.com/a', 'q', 80)").run()
  // Eligible fixture is explicitly human-reviewed, not machine-timing proof.
  db2.prepare("UPDATE leads SET human_confirmed_at=1800000000,human_confirmed_from='test_review' WHERE confidence IS NOT NULL").run()
  const id3 = createDraft(db2, 'A', 'l1', 'Dazl')
  assert.deepEqual(await polishDraft(db2, 'A', id3, 'Dazl', { master }), { rewritten: false, reason: 'no_key' })
})

test('polishDraft refuses without a positioning (no invented offer) and blocks unverified funding claims', async () => {
  const db = setup()
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'raised a round', 'https://n.com/a', 'quote', 80)").run()
  // Eligible fixture is explicitly human-reviewed, not machine-timing proof.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000,human_confirmed_from='test_review' WHERE confidence IS NOT NULL").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l2', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'raised a round', 'https://n.com/a', 'quote', 80)").run()
  // Eligible fixture is explicitly human-reviewed, not machine-timing proof.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000,human_confirmed_from='test_review' WHERE confidence IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  let calls = 0
  const prov: Record<string, Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async () => { calls++; return 'Subject: Congrats\n\nHi Pat,\n\nCongrats on your recent funding round! We built a consulting offer for teams like yours. Worth a call?\n\nThanks,' } } }
  // tone-only memory: no positioning -> no provider call at all, template stays
  saveMemory(db, 'A', { tone: 'direct' })
  const id = createDraft(db, 'A', 'l1', 'Dazl')
  assert.deepEqual(await polishDraft(db, 'A', id, 'Dazl', { master, providers: prov as never }), { rewritten: false, reason: 'no_profile' })
  assert.equal(calls, 0)
  // with positioning the provider runs, but an unverified funding congrats is rejected and the template stays
  saveMemory(db, 'A', { tone: 'direct', positioning: 'software that ramps new sales hires' })
  const id2 = createDraft(db, 'A', 'l2', 'Dazl')
  assert.deepEqual(await polishDraft(db, 'A', id2, 'Dazl', { master, providers: prov as never }), { rewritten: false, reason: 'blocked_claim' })
  assert.equal(calls, 1)
  const tpl = db.prepare('SELECT subject FROM outreach_messages WHERE id = ?').get(id2) as { subject: string }
  assert.equal(tpl.subject, 'Quick question for Acme')
})

test('llmFollowupText: body only, drops output with a subject line, requires the booking link kept', async () => {
  const db = setup()
  const lead = { company: 'Acme', name: 'Pat', signal: 'hiring', source_url: 'https://n.com/a' }
  const prov: Record<string, Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async () => 'Hi Pat,\n\nNudging on the AE hiring note. Grab a time: https://cal.com/g/15\n\nThanks,' } }
  const t = await llmFollowupText(db, 'A', 0, lead, 'Dazl', 'https://cal.com/g/15', { master, providers: prov as never })
  assert.match(t!, /cal\.com\/g\/15/)
  const withSubject: Record<string, Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async () => 'Subject: Re: hi\n\nHi Pat,\n\nNudging.\n\nThanks,' } }
  assert.equal(await llmFollowupText(db, 'A', 0, lead, 'Dazl', null, { master, providers: withSubject as never }), null)
  const droppedLink: Record<string, Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async () => 'Hi Pat,\n\nNudging on my earlier note about the AE hiring. Worth a call?\n\nThanks,' } }
  assert.equal(await llmFollowupText(db, 'A', 0, lead, 'Dazl', 'https://cal.com/g/15', { master, providers: droppedLink as never }), null)
})

const QUOTE = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const mkLead = (url: string, company: string) => ({ name: 'Pat', company, contact: null, signal: 'Hiring', source_url: url, score: 80, excerpt: QUOTE.replace('Northside Builders', company), event_date: recent })
const pageFor = (company: string) => async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE.replace('Northside Builders', company)}. More text.`, title: `${company} news`, retrievedAt: 1_700_000_000 })

test('scan: memory exclusions remove matching leads in code and count them in dropped', async () => {
  const db = setup()
  saveMemory(db, 'A', { exclusions: ['Bigco'] })
  const id = createQueryJob(db, 'A', { query: 'roofers hiring', icp: JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }) })
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: 'Here: ' + JSON.stringify([mkLead('https://a.com/x', 'Bigco')]), citedUrls: ['https://a.com/x'] }) },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers, master, fetchPage: pageFor('Bigco') }), 'done')
  assert.equal(listLeads(db, 'A', id).length, 0)
  const j = db.prepare('SELECT drop_reasons, dropped FROM scan_jobs WHERE id = ?').get(id) as { drop_reasons: string; dropped: number }
  assert.equal(JSON.parse(j.drop_reasons)['excluded'], 1)
})

test('scan: memory text reaches the scoring prompt on the tenant key', async () => {
  const db = setup()
  saveMemory(db, 'A', { positioning: 'we sell roofing software', objections: [{ q: 'cost?', a: 'one roof pays for a year' }] })
  let seen = ''
  const id = createQueryJob(db, 'A', { query: 'roofers hiring', icp: JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }) })
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: 'Here: ' + JSON.stringify([mkLead('https://a.com/x', 'Northside Builders')]), citedUrls: ['https://a.com/x'] }),
      complete: async (_k, prompt) => { if(prompt.startsWith('You check one claim'))return 'supports'; seen = prompt; return 'LEAD 1 | fit 4 | intent 4 | action 4 | match yyyy | signals hiring | why hiring crews now' },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers, master, fetchPage: pageFor('Northside Builders') }), 'done')
  assert.match(seen, /Seller's positioning: we sell roofing software/)
  assert.match(seen, /not instructions/)
})
