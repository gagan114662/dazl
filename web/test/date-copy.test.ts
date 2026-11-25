import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventDateCopy, leadCardDateLine } from '../lib/scan/date-copy.ts'
import { eventDayVerified, surfaceStoredIntent, timingUnconfirmedReason } from '../lib/scan/scoreboard.ts'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateScan, createJob, exportLeads } from '../lib/scan/store.ts'

test('unknown event date is never presented as fresh just because a scan ran', () => {
  for (const status of [null, 'undated', 'verified'])
    assert.equal(eventDateCopy(null, status), 'event date unknown - current need not confirmed')
})
test('date occurrence is distinct from current need, even when date is verified', () => {
  assert.equal(eventDateCopy('2026-01-06', 'verified'), '2026-01-06 (claimed event day; event association and current need unconfirmed)')
  for (const status of [null, 'unverified', 'undated'])
    assert.equal(eventDateCopy('2026-01-06', status), '2026-01-06 (claimed event day; event association and current need unconfirmed)')
})
test('export read preserves raw event date status with tenant isolation and no inferred date', () => {
  const db = new Database(':memory:'); migrateScan(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,date_status) VALUES('date-test',?,'Acme','signal','https://acme.example','undated')").run(job)
  const row = (exportLeads(db, 'A') as {event_date:null;date_status:string}[])[0]
  assert.equal(row.event_date, null); assert.equal(row.date_status, 'undated')
  assert.deepEqual(exportLeads(db, 'B'), [])
  db.close()
})
test('lead UI and CSV both expose date context alongside raw date fields', () => {
  const read = (p:string) => readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
  // #1176: every date line on the lead card reads through leadCardDateLine (proof, timing and window), never a bare eventDateCopy
  const client = read('app/app/leads/leads-client.tsx')
  assert.match(client, /leadCardDateLine\(l\)/); assert.doesNotMatch(client, /eventDateCopy\(/)
  assert.match(read('lib/scan/date-copy.ts'), /eventDateCopy\(l.event_date, l.date_status, l.timing, \{ dayVerified: l.day_verified, windowMissed: l.window_missed \}\)/)
  const route = read('app/api/leads/export/route.ts')
  assert.match(route, /key: 'date_status'/); assert.match(route, /key: 'date_context'/)
  assert.match(route, /date_context: eventDateCopy\(eventDate, dateStatus, timing, \{ dayVerified, windowMissed: reason === 'out_of_window' \}\)/)
  assert.match(route, /const reason = timingUnconfirmedReason\(lead, opts\)/)
  assert.match(route, /const dayVerified = eventDayVerified\(lead\)/)
})
import { savedGradeWhy } from '../lib/scan/leads-view.ts'
test('saved-grade copy never says "no saved grade" next to a saved fit/intent/action', () => {
  assert.match(savedGradeWhy({ why: 'x', fit: 4 }), /historical/)
  const g = savedGradeWhy({ why: null, fit: 4, intent: 0, action: 2 })
  assert.match(g, /saved grade exists \(fit 4, intent 0, action 2\) but no written rationale/i); assert.doesNotMatch(g, /no saved grade/)
  assert.match(savedGradeWhy({ why: null, fit: null, intent: null, action: null }), /no saved grade/)
  assert.match(savedGradeWhy({ why: null, fit: null, intent: 0, action: null }), /intent 0/)
})

test('lead CSV uses the same timing rationale as the card instead of the raw model rationale', () => {
  const route = readFileSync(new URL('../app/api/leads/export/route.ts', import.meta.url), 'utf8')
  assert.match(route, /why: savedGradeWhy\(/)
  const why = 'Proof taken from the search-result text; page not opened'
  const verified = savedGradeWhy({ why }, { timing: 'proof_backed' })
  const unconfirmed = savedGradeWhy({ why }, { timing: 'unconfirmed', reason: 'no_proof' })
  assert.match(verified, /^Event timing is verified against the cited source\./)
  assert.match(unconfirmed, /^Event timing and current need are unconfirmed\./)
  for (const rationale of [verified, unconfirmed]) assert.doesNotMatch(rationale, /page not opened/)
})

test('event day verified but recency window unresolved: never "claimed" or "association unconfirmed"; window and current need stay open', () => {
  const line = eventDateCopy('2026-01-06', 'verified', 'unconfirmed', { dayVerified: true })
  assert.match(line, /event day verified on the cited source/); assert.match(line, /recency window unresolved/); assert.match(line, /current need unconfirmed/)
  assert.doesNotMatch(line, /claimed/); assert.doesNotMatch(line, /association unconfirmed/)
  // Reason alone is not proof: without the day-verified signal the same unresolved run keeps the claimed wording.
  assert.equal(eventDateCopy('2026-01-06', 'verified', 'unconfirmed'), '2026-01-06 (claimed event day; event association and current need unconfirmed)')
})

// #1176: the review card's "Literal page check" line read the event day without its proof, so a lead whose card says
// "event date ... (verified on the cited source)" read "claimed event day ... unconfirmed" two lines below. The row is built
// exactly as app/api/leads/route.ts builds it for the card, from a stored row shaped like the prod lead in the issue
// (Zayed Law: event_date 2026-10-06, event_date_proof page_bound, date_status unverified).
test('#1176 the review card check line reads a proven event day as the card does, never as a claimed day', () => {
  const stored = { event_date: '2026-10-06', event_date_proof: 'page_bound', date_status: 'unverified', signal: 'Opened a new office in Chicago', signal_kind: null, intent: 3 }
  const asCard = (windowDays: number | null) => {
    const opts = { windowDays, timingRequired: windowDays != null }
    const tr = timingUnconfirmedReason(stored, opts)
    return { ...stored, timing: surfaceStoredIntent(stored, opts).timing, day_verified: eventDayVerified(stored), window_missed: tr === 'out_of_window' }
  }
  const card = (l: ReturnType<typeof asCard>) => eventDateCopy(l.event_date, l.date_status, l.timing, { dayVerified: l.day_verified, windowMissed: l.window_missed })
  for (const w of [null, 365, 7]) {
    const l = asCard(w)
    assert.equal(leadCardDateLine(l), card(l), `window ${w}`)
    assert.doesNotMatch(leadCardDateLine(l), /claimed event day|event association/)
  }
  // control: no proof (a retired date_status 'verified' row) stays a claimed day
  const legacy = { ...asCard(null), event_date_proof: null, date_status: 'verified', day_verified: false, timing: 'unconfirmed' as const }
  assert.match(leadCardDateLine(legacy), /claimed event day/)
})
