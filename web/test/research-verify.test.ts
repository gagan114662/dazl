import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { verifyLead, quoteOnPage, dateQuoteNames, inWindow, type Decide } from '../lib/research/verify.ts'
import { eventsFromReply, readPrompt, parseJsonReply } from '../lib/research/read-page.ts'

// MISSION v2 part D (Refs #1099): the research engine's read and verify stages. Fixture: six of the ai-research prototype's 83 "ready"
// leads with the real pages it opened on 2026-11-14 and the second-model answers it recorded.
type Rec = { company: string; why_now: string; trigger_quote: string; event_date: string; date_quote: string; source_url: string; source_text: string; person: string | null; title: string | null; person_quote: string | null; person_url: string | null; person_text: string | null; prototype: { trigger_p: number | null; person_p: number | null } }
const recs = (JSON.parse(readFileSync(new URL('./fixtures/research-verify/prototype-leads.json', import.meta.url), 'utf8')) as { leads: Rec[] }).leads
const rec = (c: string) => recs.find(r => r.company === c)!
const NOW = Date.parse('2026-11-14T12:00:00Z')
const recorded = (r: Rec): Decide => async (_s, q) => ('claim' in q ? { claim: r.prototype.trigger_p } : { role: r.prototype.person_p })
const verify = (r: Rec, over: Partial<Rec> = {}, decide: Decide = recorded(r)) => {
  const x = { ...r, ...over }
  const person = x.person && x.person_quote ? { name: x.person, title: x.title, quote: x.person_quote, sourceUrl: x.person_url ?? x.source_url, sourceText: x.person_text ?? x.source_text } : null
  return verifyLead({ company: x.company, whatHappened: x.why_now, whyNow: x.why_now, quote: x.trigger_quote, eventDate: x.event_date, dateQuote: x.date_quote, sourceUrl: x.source_url }, { url: x.source_url, text: x.source_text, readAt: NOW }, person, decide, { now: NOW })
}

test('a real lead whose every claim is on its opened pages is READY: MBLB moved to a larger Chicago office (2 Oct 2026), Managing Member Alan Brackett', async () => {
  const v = await verify(rec('Mouledoux, Bland, Legrand & Brackett'))
  assert.equal(v.ready, true, v.why ?? '')
  assert.deepEqual({ literal: v.event.literal, day: v.day.date, inWindow: v.day.inWindow, person: v.person.name, personOk: v.person.ok }, { literal: true, day: '2026-10-02', inWindow: true, person: 'Alan G. Brackett', personOk: true })
  assert.ok(v.event.passage.includes('three attorneys'), 'the second model is shown the passage around the quote')
})

test('a quote stitched from different rows of a listing is refused - the prototype accepted it (any 8 words) with a date from another row (Yoon Black Dentistry)', async () => {
  const r = rec('Yoon Black Dentistry')
  assert.match(r.source_text.toLowerCase().replace(/\s+/g, ' '), /dentist yoon black dentistry toronto \(on\) indeed\.com nov 3, 2026/, 'the page lists this job on Nov 3, not Nov 12')
  const v = await verify(r)
  assert.equal(v.ready, false); assert.equal(v.why, 'the quote is not on the cited page')
})

test('a headline quoted with a full stop the page does not print still matches (HAL appoints PB Rangarao); a changed word, a skipped word or an inner "..." never does', async () => {
  const r = rec('HAL')
  assert.equal(quoteOnPage(r.trigger_quote, r.source_text), true)
  assert.equal(quoteOnPage(r.trigger_quote.replace('Operations Director', 'Finance Director'), r.source_text), false)
  assert.equal(quoteOnPage(r.trigger_quote.replace(' limited series', ''), r.source_text), false)
  assert.equal(quoteOnPage(r.trigger_quote.replace('He also oversaw', '... He also oversaw'), r.source_text), false, 'an ellipsis inside the quote')
  assert.equal(quoteOnPage(`... ${r.trigger_quote}`, r.source_text), true, 'an ellipsis at the start only marks a cut')
  assert.equal(quoteOnPage('Rangarao', r.source_text), false, 'fewer than 4 words is not a quote')
})

test('the second model decides: a quote on the page whose passage the second model does not support, or a second check that could not run, is not ready', async () => {
  const r = rec('Mouledoux, Bland, Legrand & Brackett')
  assert.equal((await verify(r, {}, async (_s, q) => ('claim' in q ? { claim: 0.2 } : { role: 1 }))).why, 'the cited passage does not support the event')
  assert.equal((await verify(r, {}, async () => null)).why, 'the second check could not run')
  assert.equal((await verify(r, {}, async () => { throw new Error('rate limited') })).why, 'the second check could not run')
  assert.equal((await verify(r, {}, async (_s, q) => ('claim' in q ? { claim: 1 } : { role: 0.1 }))).why, 'the cited page does not show the person in a senior role there')
})

test('the event day must be stated on the cited page, name that day and fall inside the 90-day window', async () => {
  const r = rec('Mouledoux, Bland, Legrand & Brackett')
  assert.equal((await verify(r, { date_quote: 'October 9, 2026' })).why, 'the event day is not stated on the cited page', 'a date the page does not print')
  assert.equal((await verify(r, { event_date: '2026-10-03' })).why, 'the event day is not stated on the cited page', 'the quote names another day')
  assert.equal((await verify(r, { event_date: null as never })).why, 'the event day is not stated on the cited page')
  const old = await verifyLead({ company: r.company, whatHappened: r.why_now, whyNow: r.why_now, quote: r.trigger_quote, eventDate: r.event_date, dateQuote: r.date_quote, sourceUrl: r.source_url }, { url: r.source_url, text: r.source_text, readAt: NOW }, null, recorded(r), { now: Date.parse('2027-02-15T12:00:00Z') })
  assert.equal(old.why, 'the event day is outside the time window')
  // the page's own declared dates count as the page (Cloud Wave's claimed day 2026-09-10 is NOT its published day 2026-09-11: refused)
  const cw = rec('Cloud Wave Technologies')
  assert.equal((await verify(cw)).why, 'the event day is not stated on the cited page')
  assert.equal(dateQuoteNames('2026-09-11', 'article:published_time: 2026-09-11T06:11:48.000Z', NOW), true)
  for (const [d, q, ok] of [['2026-10-02', 'October 2, 2026', true], ['2026-10-02', '2 Oct 2026', true], ['2026-10-02', 'Oktober 2026', true], ['2026-10-02', '02.10.2026', true], ['2026-10-02', 'October 2025', false], ['2026-10-02', '2026', false], ['2026-11-11', '3 days ago', true], ['2026-11-11', '3 months ago', false], ['2026-11-14', 'today', true], ['2026-11-01', 'yesterday', false]] as [string, string, boolean][]) assert.equal(dateQuoteNames(d, q, NOW), ok, `${d} / ${q}`)
  assert.equal(inWindow('2026-11-20', NOW), false, 'ahead of today'); assert.equal(inWindow('2026-08-16', NOW), true); assert.equal(inWindow('2026-08-15', NOW), false); assert.equal(inWindow('2026-02-30', NOW), false)
})

test('the person must be named on the page they were found on, with the surname in the passage; a reworded attribution is refused (Ogletree Deakins), a missing person is "no named person"', async () => {
  const og = await verify(rec('Ogletree Deakins'))
  assert.equal(og.why, 'the person is not named on their cited page', 'the quote moves the attribution before the sentence; the page has it after')
  const r = rec('Mouledoux, Bland, Legrand & Brackett')
  assert.equal((await verify(r, { person: 'Jane Roe' })).why, 'the person is not named on their cited page', 'a different name with the same quote')
  assert.equal((await verify(r, { person: null })).why, 'no named person')
})

test('read-page: events come from the model reply only when their quote is on the page; wrong types are dropped, never coerced', () => {
  const r = rec('Mouledoux, Bland, Legrand & Brackett')
  const page = { url: r.source_url, title: 'MBLB', text: r.source_text }
  const reply = '```json\n' + JSON.stringify({ events: [
    { company: r.company, website: 'mblb.com', page_is_companys_own_site: true, trigger_id: 't1', what_happened: 'moved to a larger Chicago office', why_now: 'x', quote: r.trigger_quote, event_date: '2026-10-02', date_quote: 'October 2, 2026', location_quote: 'Chicago', people: [{ name: 'Alan G. Brackett', title: 'Managing Member', quote: r.person_quote }, { name: 7, quote: 'x' }] },
    { company: 'Invented Co', quote: 'Invented Co opened ten offices in Chicago this week to great fanfare' },
    { company: 'Bad Date', quote: r.trigger_quote, event_date: '2 October' },
    'not an object', { quote: r.trigger_quote },
  ] }) + '\n```'
  const evs = eventsFromReply(reply, page)
  assert.deepEqual(evs.map(e => [e.company, e.eventDate, e.people.length]), [[r.company, '2026-10-02', 1], ['Bad Date', null, 0]])
  assert.equal(evs[0].sourceUrl, r.source_url); assert.equal(evs[0].pageIsCompanysOwnSite, true)
  assert.deepEqual(eventsFromReply('no json here', page), []); assert.deepEqual(eventsFromReply('{"events": "nope"}', page), [])
  assert.deepEqual(parseJsonReply('Sure! {"a":1} done'), { a: 1 })
  const p = readPrompt({ ...page, metaDates: ['article:published_time: 2026-10-02'] }, { today: '2026-11-14', category: 'Law firms', location: 'Chicago, Illinois', offer: 'intake software', triggers: [{ id: 't1', name: 'new office' }] })
  assert.match(p, /PAGE META DATES: article:published_time: 2026-10-02/); assert.match(p, /copy quotes character for character; never invent/); assert.ok(p.length < 12_000)
})

test('the proof of a READY verdict makes a stored lead Ready by the same rule Home and the Leads page use, and stops counting the moment the lead drifts from what was proven', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { measureCase } = await import('../scripts/matrix-score.mts')
  const { writeResearchProof, researchProofGap } = await import('../lib/research/proof.ts')
  const r = rec('Mouledoux, Bland, Legrand & Brackett')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const J = 'r'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Law firms in Chicago, Illinois that opened or expanded an office', NULL, 'running', 1, ?)").run(J, Math.floor(NOW / 1000) - 3600)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, fit, created_at) VALUES ('L1', ?, ?, ?, ?, 80, ?, 4, ?)").run(J, r.company, 'moved to a larger Chicago office', r.source_url, r.trigger_quote, Math.floor(NOW / 1000) - 600)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(J)
  const home = () => measureCase(db, 'A', J, { expect: { location_keywords: ['chicago'], category_keywords: ['law'] } }, new Date(NOW))
  assert.equal(home().ready, 0, 'stored but not proven: held'); assert.deepEqual(home().held, { 'event timing unknown': 1 })
  const ev = { company: r.company, whatHappened: r.why_now, whyNow: r.why_now, quote: r.trigger_quote, eventDate: r.event_date, dateQuote: r.date_quote, sourceUrl: r.source_url }
  const person = { name: r.person!, title: r.title, quote: r.person_quote!, sourceUrl: r.person_url!, sourceText: r.person_text ?? r.source_text }
  const v = await verifyLead(ev, { url: r.source_url, text: r.source_text, readAt: NOW }, person, recorded(r), { now: NOW })
  assert.equal(v.ready, true)
  // a verdict that is not ready, or a lead whose stored quote is not the proven one, gets nothing written
  assert.equal(writeResearchProof(db, 'A', 'L1', { ...v, ready: false }, ev, person, new Date(NOW)), false)
  assert.equal(writeResearchProof(db, 'A', 'L1', v, { ...ev, quote: 'another quote' }, person, new Date(NOW)), false)
  assert.equal(writeResearchProof(db, 'B', 'L1', v, ev, person, new Date(NOW)), false, 'another tenant\'s lead')
  assert.equal(researchProofGap(db, 'A', 'L1', new Date(NOW)), 'no_record')
  assert.equal(writeResearchProof(db, 'A', 'L1', v, ev, person, new Date(NOW)), true)
  assert.equal(researchProofGap(db, 'A', 'L1', new Date(NOW)), null)
  const m = home(); assert.equal(m.ready, 1, JSON.stringify(m.held)); assert.equal(m.named_pct, 100); assert.equal(m.dated_pct, 100)
  const stored = db.prepare("SELECT event_date, event_date_proof FROM leads WHERE id = 'L1'").get() as { event_date: string; event_date_proof: string }
  assert.deepEqual({ ...stored }, { event_date: '2026-10-02', event_date_proof: 'page_bound' })
  const shown = db.prepare("SELECT kind, value, label, source_url FROM lead_enrichments WHERE lead_id = 'L1' AND kind <> 'timing_proof'").all()
  assert.deepEqual(shown, [{ kind: 'person', value: 'Alan G. Brackett', label: 'Managing Member', source_url: r.person_url }], 'the card shows the person with the page that names them; the binding record is internal')
  // drift: the stored quote changes, the day changes, the person row goes, the window passes, a review reason appears -> held again
  const again = (sql: string, gap: string, undo: string) => { db.prepare(sql).run(); assert.equal(researchProofGap(db, 'A', 'L1', new Date(NOW)), gap, sql); assert.equal(home().ready, 0, sql); db.prepare(undo).run() }
  again("UPDATE leads SET evidence_excerpt = evidence_excerpt || ' (edited)' WHERE id = 'L1'", 'binding_changed', `UPDATE leads SET evidence_excerpt = '${r.trigger_quote.replace(/'/g, "''")}' WHERE id = 'L1'`)
  again("UPDATE leads SET event_date = '2026-10-05' WHERE id = 'L1'", 'binding_changed', "UPDATE leads SET event_date = '2026-10-02' WHERE id = 'L1'")
  again("UPDATE leads SET review_reason = 'quote_unconfirmed' WHERE id = 'L1'", 'needs_review', "UPDATE leads SET review_reason = NULL WHERE id = 'L1'")
  db.prepare("DELETE FROM lead_enrichments WHERE lead_id = 'L1' AND kind = 'person'").run()
  assert.equal(researchProofGap(db, 'A', 'L1', new Date(NOW)), 'person_missing'); assert.equal(home().ready, 0)
  assert.equal(writeResearchProof(db, 'A', 'L1', v, ev, person, new Date(NOW)), true)
  assert.equal(researchProofGap(db, 'A', 'L1', new Date(Date.parse('2027-01-15T12:00:00Z'))), 'out_of_window')
  assert.equal(home().ready, 1)
})

test('the proof fits the store whatever the person page and name (Lane A: 5 of 9 ready Chicago leads lost it to the 254-character value CHECK); a store refusal returns false and writes nothing', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { writeResearchProof, researchProofGap } = await import('../lib/research/proof.ts')
  const r = rec('Mouledoux, Bland, Legrand & Brackett')
  const setup = () => {
    const db = new Database(':memory:'); migrateAllSqlite(db)
    const J = 'r'.repeat(24)
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Law firms in Chicago', 'running', 1, ?)").run(J, Math.floor(NOW / 1000) - 3600)
    db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, fit, created_at) VALUES ('L1', ?, ?, 'moved', ?, 80, ?, 4, ?)").run(J, r.company, r.source_url, r.trigger_quote, Math.floor(NOW / 1000) - 600)
    return db
  }
  const ev = { company: r.company, whatHappened: r.why_now, whyNow: r.why_now, quote: r.trigger_quote, eventDate: r.event_date, dateQuote: r.date_quote, sourceUrl: r.source_url }
  const base = { name: r.person!, title: r.title, quote: r.person_quote!, sourceUrl: r.person_url!, sourceText: r.person_text ?? r.source_text }
  const v = await verifyLead(ev, { url: r.source_url, text: r.source_text, readAt: NOW }, base, recorded(r), { now: NOW })
  assert.equal(v.ready, true)
  // a team / bio page URL of 240 characters, and a name of 300 (model output): written, and the proof stands
  const longUrl = `https://www.mblb.com/our-team/attorneys/managing-members/${'alan-g-brackett-'.repeat(12)}profile`
  assert.ok(longUrl.length > 200)
  for (const person of [{ ...base, sourceUrl: longUrl }, { ...base, name: `${r.person!} ${'X'.repeat(300)}`, sourceUrl: longUrl }]) {
    const db = setup()
    assert.equal(writeResearchProof(db, 'A', 'L1', v, ev, person, new Date(NOW)), true, `url ${person.sourceUrl.length}, name ${person.name.length}`)
    assert.equal(researchProofGap(db, 'A', 'L1', new Date(NOW)), null, 'never person_missing for a long name or page')
    const rows = db.prepare("SELECT kind, length(value) n FROM lead_enrichments WHERE lead_id = 'L1'").all() as { kind: string; n: number }[]
    for (const row of rows) assert.ok(row.n <= 254, JSON.stringify(row))
  }
  // the store refuses (here: a trigger, standing in for any constraint or store fault): false, nothing written, nothing thrown
  const db = setup()
  db.exec("CREATE TRIGGER refuse BEFORE INSERT ON lead_enrichments BEGIN SELECT RAISE(ABORT, 'refused by the store'); END")
  assert.equal(writeResearchProof(db, 'A', 'L1', v, ev, base, new Date(NOW)), false)
  assert.deepEqual({ ...(db.prepare("SELECT event_date, event_date_proof FROM leads WHERE id = 'L1'").get() as object) }, { event_date: null, event_date_proof: null }, 'rolled back')
  assert.equal(researchProofGap(db, 'A', 'L1', new Date(NOW)), 'no_record')
})

test('a lead the research proof never marked costs the gate one read (the old engine path)', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const { researchProofGap } = await import('../lib/research/proof.ts')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('J', 'A', 'x', 'y', 'z', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence) VALUES ('L1', 'J', 'Co', 's', 'https://co.example/', 80)").run()
  const seen: string[] = []
  const spy = new Proxy(db, { get: (t, k) => k === 'prepare' ? (sql: string) => { seen.push(sql); return t.prepare(sql) } : Reflect.get(t, k) })
  assert.equal(researchProofGap(spy as typeof db, 'A', 'L1', new Date(NOW)), 'no_record')
  assert.equal(seen.length, 1, seen.join('\n'))
})

test('goal loop (run.ts calls verify many times per run): a stable code per verdict; a spend refusal reads "budget", not a dead end; the held lead keeps its event score; memoDecide pays an identical question once and never keeps a failed answer', async () => {
  const { memoDecide } = await import('../lib/research/verify.ts')
  const { SpendRefused } = await import('../lib/llm/spend-guard.ts')
  const r = rec('Mouledoux, Bland, Legrand & Brackett')
  let calls = 0
  const counting = (d: Decide): Decide => async (s, q) => { calls++; return d(s, q) }
  // each outcome has its code
  assert.equal((await verify(r)).code, 'ready')
  assert.equal((await verify(r, { trigger_quote: 'a sentence that is nowhere on this page at all' })).code, 'quote_not_on_page')
  assert.equal((await verify(r, { person: null })).code, 'no_person')
  assert.equal((await verify(r, {}, async (_s, q) => ('claim' in q ? { claim: 0.1 } : { role: 0.9 }))).code, 'event_unsupported')
  assert.equal((await verify(r, {}, async (_s, q) => ('claim' in q ? { claim: 0.9 } : { role: 0.1 }))).code, 'person_unsupported')
  // a held lead (no day on the page) still carries the event score the review lane shows: the checks are asked as before
  const noDay = await verify(r, { date_quote: 'not a date that is on the page' })
  assert.deepEqual([noDay.code, noDay.event.ok, typeof noDay.event.support], ['no_day_on_page', true, 'number'])
  // a provider error vs the spend limit (thrown, or as the cause, on either question): both fail closed, only the latter says "budget"
  const broken = await verify(r, {}, async () => { throw new Error('provider down') })
  assert.deepEqual([broken.ready, broken.code], [false, 'check_failed'])
  const capped = await verify(r, {}, async () => { throw new SpendRefused('owner_pool_limit') })
  assert.deepEqual([capped.ready, capped.code, capped.why], [false, 'budget', 'the spend limit stopped the second check'])
  const wrapped = await verify(r, {}, async () => { throw new Error('fallback failed', { cause: new SpendRefused('owner_pool_limit') }) })
  assert.equal(wrapped.code, 'budget')
  const roleCapped = await verify(r, {}, async (_s, q) => { if ('claim' in q) return { claim: 0.9 }; throw new SpendRefused('owner_pool_limit') })
  assert.deepEqual([roleCapped.ready, roleCapped.code], [false, 'budget'])
  // memoDecide: the same lead verified again in a later round costs nothing
  calls = 0
  const memo = memoDecide(counting(recorded(r)))
  await verify(r, {}, memo); await verify(r, {}, memo)
  assert.equal(calls, 2, 'claim + role once, not twice')
  // an unreadable answer ({ claim: null }) or a thrown one is asked again on the next round
  let first = true
  const flaky = memoDecide(counting(async (s, q) => { if (first && 'claim' in q) { first = false; return { claim: null } } return recorded(r)(s, q) }))
  calls = 0
  assert.equal((await verify(r, {}, flaky)).code, 'check_failed')
  assert.equal((await verify(r, {}, flaky)).code, 'ready', 'the unreadable answer was not remembered')
  // two identical questions at once share one call; when it fails, both see the failure and the next round asks again
  calls = 0
  let fail = true
  const shared = memoDecide(counting(async (s, q) => { await new Promise(res => setTimeout(res, 5)); if (fail) throw new SpendRefused('owner_pool_limit'); return recorded(r)(s, q) }))
  const [a1, a2] = await Promise.all([verify(r, {}, shared), verify(r, {}, shared)])
  assert.deepEqual([a1.code, a2.code, calls], ['budget', 'budget', 2], 'the claim and the role question, each once for both')
  fail = false
  assert.equal((await verify(r, {}, shared)).code, 'ready')
})
