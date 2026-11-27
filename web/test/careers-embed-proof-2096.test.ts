// #2004 careers pages: a company careers page that EMBEDS its board names its own posting record. Ziggy's review of #2096 asked for two
// things this file pins through real code (no mocks beyond a fake board response):
//   - the day that record supplies carries the board-record proof kind (ats_structured) and the record's own citation, through the
//     production projection and the persisted column, so the Ready reader can use it - and it is never called page_bound;
//   - the acquisition is bound to a confirmed HIRING event whose page prints that posting's title: a funding page that happens to embed
//     an unrelated vacancy never borrows that vacancy's day, and neither does a page whose text names a different posting.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { careersAtsDate, embeddedAtsPosting } from '../lib/discover/ats-dates.ts'
import { checkLead } from '../lib/discover/check.ts'
import { discoveredLead } from '../lib/scan/runner.ts'
import { eventDayVerified } from '../lib/scan/scoreboard.ts'
import { migrateScan } from '../lib/scan/store.ts'

const CAREERS = 'https://careers.example.test/jobs/sales-development-representative'
const ROLE = 'Sales Development Representative'
const RECORD = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345'
const EMBED = `<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345"></iframe>`
const QUOTE = `Acme Software is hiring a ${ROLE} for its Austin office`
const DAY = '2026-11-15'
const NOW = new Date('2026-11-25T00:00:00Z')

// The board's record for exactly this posting: its title, its publish day and its own URL. The careers page itself answers as dazl's
// own read of it (the path that sees the embed markup).
const board = (title = ROLE, page = `${QUOTE}. ${EMBED} Come and build with us.`) => (async (url: string | URL | Request) => {
  const u = String(url instanceof Request ? url.url : url)
  if (u === CAREERS) return { ok: true, status: 200, json: async () => ({}), text: async () => page }
  if (u !== RECORD) return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  return { ok: true, status: 200, json: async () => ({ id: 4012345, title, first_published: DAY }), text: async () => '' }
}) as unknown as typeof fetch

const lead = (signal = `hiring a ${ROLE}`) => ({
  company: 'Acme Software', signal, source_url: CAREERS, evidence_url: CAREERS, excerpt: QUOTE, event_date: null, confidence: 'high', person: null, why: '',
}) as never

test('#2096 helper: the embedded record dates the page only when the page prints that posting title', async () => {
  assert.ok(embeddedAtsPosting(`${QUOTE} ${EMBED}`, CAREERS), 'the embed is read')
  const bound = await careersAtsDate(`${QUOTE}. ${EMBED}`, CAREERS, board(), NOW)
  assert.deepEqual(bound, { date: DAY, sourceUrl: RECORD, platform: 'greenhouse', title: ROLE })
  assert.equal(await careersAtsDate(`${QUOTE}. ${EMBED}`, CAREERS, board('Office Manager'), NOW), null, 'another posting never dates this page')
  assert.equal(await careersAtsDate(`${QUOTE}.`, CAREERS, board(), NOW), null, 'no embed, no record')
})

test('#2096 check: a confirmed hiring lead on an embedding careers page keeps the day with the record citation, date_on_page false', async () => {
  const c = await checkLead(lead(), [], board(), 5_000, NOW)
  assert.equal(c.proof, 'confirmed', JSON.stringify({ proof: c.proof, lacks: c.claim_lacks }))
  assert.equal(c.date, DAY)
  assert.equal(c.date_on_page, false, 'the day is not printed in the page text')
  assert.equal(c.date_proof, 'ats_structured')
  assert.equal(c.date_record_url, RECORD)
})

test('#2096 check: a funding signal on the same page never borrows the embedded vacancy day', async () => {
  const funding = 'Acme Software raised $6M in seed funding to grow its Austin team'
  const c = await checkLead(lead('raised seed funding'), [], board(ROLE, `${funding}. ${EMBED}`), 5_000, NOW)
  assert.equal(c.date, null, 'an unrelated event is never dated by an embedded vacancy')
  assert.equal(c.date_proof ?? null, null)
})

test('#2096 projection: the board record becomes ats_structured with the record citation, never page_bound', () => {
  const l = { ...(lead() as unknown as Record<string, unknown>), proof: 'confirmed', proof_read_by: 'reader', quote_on_page: true, signal_seen: true,
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

test('#2096 persistence: the store keeps ats_structured with its note, and the Ready reader accepts it for a hiring lead only', () => {
  const db = new Database(':memory:'); migrateScan(db)
  db.exec("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES ('j1', 'A', 'running', 'Acme', 'software', 'Austin')")
  const ins = db.prepare(`INSERT INTO leads (id, scan_job_id, company, signal, source_url, evidence_excerpt, confidence, score, event_date, date_status, event_date_proof, event_date_proof_note, retrieved_at, source_kind)
    VALUES (?, 'j1', 'Acme Software', ?, ?, ?, 80, 80, ?, 'verified', 'ats_structured', ?, 1, 'discover')`)
  ins.run('l1', `hiring a ${ROLE}`, CAREERS, QUOTE, DAY, `the day comes from the posting's own board record ${RECORD}`)
  ins.run('l2', 'raised seed funding', CAREERS, QUOTE, DAY, `the day comes from the posting's own board record ${RECORD}`)
  const rows = db.prepare('SELECT id, signal, event_date, event_date_proof, event_date_proof_note FROM leads ORDER BY id').all() as { id: string; signal: string; event_date: string; event_date_proof: string; event_date_proof_note: string }[]
  assert.equal(rows.length, 2)
  assert.equal(rows[0].event_date_proof, 'ats_structured')
  assert.ok(rows[0].event_date_proof_note.includes(RECORD))
  assert.equal(eventDayVerified(rows[0], { now: NOW }), true, 'a hiring lead is Ready on the board record')
  assert.equal(eventDayVerified(rows[1], { now: NOW }), false, 'a funding lead is never Ready on a posting day')
})
