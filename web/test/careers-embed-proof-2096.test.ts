// #2004 careers pages: a company careers page that EMBEDS its board names its own posting record. Ziggy's second review of #2096 asked
// for the record to be bound to the CLAIMED hiring event, not merely to some title on the page, and for one connected regression through
// the real lane (check -> production projection -> production insert -> persisted row -> Ready reader). Every case below runs real code:
// a fake board answer, a fake page, and a canned discovery loop - no network, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { careersAtsDate, embeddedAtsPosting } from '../lib/discover/ats-dates.ts'
import { checkLead } from '../lib/discover/check.ts'
import { discoveredLead } from '../lib/scan/runner.ts'
import { eventDayVerified } from '../lib/scan/scoreboard.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'

const CAREERS = 'https://careers.example.test/jobs/sales-development-representative'
const ROLE = 'Sales Development Representative'
const RECORD = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345'
const EMBED = `<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345"></iframe>`
// The same embed written the way real markup escapes it.
const EMBED_ESCAPED = `<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=4012345"></iframe>`
const QUOTE = `Acme Software is hiring a ${ROLE} for its Austin office`
const DAY = '2026-11-15'
const NOW = new Date('2026-11-25T00:00:00Z')

// The board's record for the posting the iframe names. The careers page answers as dazl's own read of it (the path that sees the embed
// markup); the embed attribute is HTML-escaped the way real markup writes it.
const board = (title = ROLE, page = `${QUOTE}. ${EMBED} Come and build with us.`) => (async (url: string | URL | Request) => {
  const u = String(url instanceof Request ? url.url : url)
  if (u === CAREERS) return { ok: true, status: 200, json: async () => ({}), text: async () => page }
  if (u !== RECORD) return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  return { ok: true, status: 200, json: async () => ({ id: 4012345, title, first_published: DAY }), text: async () => '' }
}) as unknown as typeof fetch

const claim = (signal = `hiring a ${ROLE}`, quote = QUOTE) => ({
  company: 'Acme Software', signal, evidence_url: CAREERS, evidence_quote: quote, signal_date: null, person: null, title: null,
  person_source_url: null, linkedin_url: null, email: null, email_source_url: null, domain: null, confidence: 'high', why: 'careers page',
}) as never

test('#2096 helper: the escaped embed names the record, and its day is the day when the claim is that posting', async () => {
  assert.ok(embeddedAtsPosting(`${QUOTE} ${EMBED_ESCAPED}`, CAREERS), 'the HTML-escaped embed is read')
  const bound = await careersAtsDate(`${QUOTE}. ${EMBED_ESCAPED}`, CAREERS, board(), NOW, undefined, undefined, `We are hiring ${ROLE}s now`)
  assert.deepEqual(bound, { date: DAY, sourceUrl: RECORD, platform: 'greenhouse', title: ROLE })
  assert.equal(await careersAtsDate(`${QUOTE}. ${EMBED}`, CAREERS, board('Office Manager'), NOW), null, 'another posting never dates this page')
  assert.equal(await careersAtsDate(`${QUOTE}.`, CAREERS, board(), NOW), null, 'no embed, no record')
})

test('#2096 check: a confirmed hiring lead on an embedding careers page keeps the day with the record citation, date_on_page false', async () => {
  const c = await checkLead(claim(), [], board(), 5_000, NOW)
  assert.equal(c.proof, 'confirmed', JSON.stringify({ proof: c.proof, lacks: c.claim_lacks }))
  assert.equal(c.date, DAY)
  assert.equal(c.date_on_page, false, 'the day is not printed in the page text')
  assert.equal(c.date_proof, 'ats_structured')
  assert.equal(c.date_record_url, RECORD)
})

test('#2096 check: a sidebar vacancy on a page announcing another role never dates that claim', async () => {
  // The page announces engineers; the only iframe is an Office Manager posting printed in the sidebar. The claim is the engineering hire,
  // so the sidebar vacancy's day is somebody else's day.
  const engineering = 'Acme Software is hiring software engineers for its Austin office'
  const page = `${engineering}. Open roles: Office Manager. ${EMBED}`
  const c = await checkLead(claim('hiring software engineers', engineering), [], board('Office Manager', page), 5_000, NOW)
  assert.equal(c.proof, 'confirmed', 'the claim itself is confirmed on the page')
  assert.equal(c.signal_seen, true)
  assert.equal(c.quote_on_page, true)
  assert.equal(c.date, null, 'a different vacancy never dates this claim')
  assert.equal(c.date_proof ?? null, null)
  assert.equal(c.date_record_url ?? null, null)
})

test('#2096 check: a funding signal on the same page never borrows the embedded vacancy day', async () => {
  const funding = 'Acme Software raised $6M in seed funding to grow its Austin team'
  const c = await checkLead(claim('raised seed funding', funding), [], board(ROLE, `${funding}. ${EMBED}`), 5_000, NOW)
  assert.equal(c.proof, 'confirmed', 'the funding claim is confirmed, so the refusal is not a broken fixture')
  assert.equal(c.signal_seen, true)
  assert.equal(c.quote_on_page, true)
  assert.equal(c.date, null, 'an unrelated event is never dated by an embedded vacancy')
  assert.equal(c.date_proof ?? null, null)
})

test('#2096 projection: the board record becomes ats_structured with the record citation, never page_bound', () => {
  const l = { ...(claim() as unknown as Record<string, unknown>), proof: 'confirmed', proof_read_by: 'reader', quote_on_page: true, signal_seen: true,
    claim_lacks: [], page_age: null, date: DAY, date_source: 'page', date_on_page: false, date_proof: 'ats_structured', date_record_url: RECORD } as never
  const p = discoveredLead(l, NOW.getTime())
  assert.equal(p.event_date, DAY)
  assert.equal(p.event_date_proof, 'ats_structured')
  assert.match(p.event_date_proof_note ?? '', /board record/)
  assert.ok((p.event_date_proof_note ?? '').includes(RECORD), `note cites the record: ${p.event_date_proof_note}`)
  assert.ok((p.event_date_proof_note ?? '').length <= 200)
  assert.equal(p.date_status, 'verified')
  // without the record's URL there is no proof: the day is never presented as page evidence
  const bare = discoveredLead({ ...(l as unknown as Record<string, unknown>), date_record_url: null } as never, NOW.getTime())
  assert.equal(bare.event_date_proof, null)
  assert.equal(bare.date_status, 'unverified')
})

test('#2096 storage: the store keeps ats_structured with its note, and the Ready reader accepts it for a hiring lead only', () => {
  const db = new Database(':memory:'); migrateScan(db)
  db.exec("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES ('j1', 'A', 'running', 'Acme', 'software', 'Austin')")
  const ins = db.prepare(`INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, confidence, score, event_date, date_status, event_date_proof, event_date_proof_note, retrieved_at, source_kind)
    VALUES (?, 'j1', 'Acme Software', ?, ?, ?, 80, 80, ?, 'verified', 'ats_structured', ?, 1, 'discover')`)
  ins.run('l1', `hiring a ${ROLE}`, CAREERS, QUOTE, DAY, `the day comes from the posting's own board record ${RECORD}`)
  ins.run('l2', 'raised seed funding', CAREERS, QUOTE, DAY, `the day comes from the posting's own board record ${RECORD}`)
  const rows = db.prepare('SELECT id, signal, event_date, event_date_proof, event_date_proof_note FROM leads ORDER BY id').all() as { id: string; signal: string; event_date: string; event_date_proof: string; event_date_proof_note: string }[]
  assert.equal(rows[0].event_date_proof, 'ats_structured')
  assert.ok(rows[0].event_date_proof_note.includes(RECORD))
  assert.equal(eventDayVerified(rows[0], { now: NOW }), true, 'a hiring lead is Ready on the board record')
  assert.equal(eventDayVerified(rows[1], { now: NOW }), false, 'a funding lead is never Ready on a posting day')
})

test('#2096 connected: the real lane writes the board record as ats_structured with its citation, and Ready reads it back', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Software companies hiring sales development representatives in Austin', seller: 'Sales training' })
  const job = claimKeyedJob(db, id); assert.ok(job)
  const lead: DiscoveredLead = {
    company: 'Acme Software', domain: null, signal: `Acme Software is hiring a ${ROLE}`, signal_date: null, evidence_url: CAREERS,
    evidence_quote: QUOTE, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'high', why: 'careers page names its own posting',
  }
  const canned: DiscoverResult = {
    leads: [lead], seen: [], stop: 'end_turn', model: 'stub',
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.05 }, note: null,
  }
  let passes = 0
  const result = await runJob(db, job!, {
    master, discover: true, enrichImpl: null, fetchImpl: board(),
    discoverImpl: async () => { passes++; return passes === 1 ? canned : { ...canned, leads: [], seen: [] } },
  })
  assert.equal(result, 'done')
  const rows = listLeads(db, 'T', id, 50, true) as (Record<string, unknown> & { company: string; event_date: string | null; event_date_proof: string | null; event_date_proof_note: string | null; source_url: string; signal: string })[]
  const row = rows.find(r => r.company === 'Acme Software')
  assert.ok(row, `the lead was written: ${JSON.stringify(rows.map(r => r.company))}`)
  assert.equal(row!.source_url, CAREERS)
  assert.equal(row!.event_date, DAY)
  assert.equal(row!.event_date_proof, 'ats_structured', 'the persisted proof kind is the board record, not page_bound')
  assert.ok((row!.event_date_proof_note ?? '').includes(RECORD), `the persisted note cites the record: ${row!.event_date_proof_note}`)
  assert.equal(eventDayVerified(row!, { now: NOW }), true, 'Ready reads the persisted board record')
})
