// #874: an offer's reviewed buyer targeting stays with the SAME offer across reruns. Synthetic seller sites (invented companies); stubbed model output; no
// network, no key, no provider. Run (network-fenced): SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --import ./test/helpers/net-fence.ts --test test/seller-research-874-offer-identity.test.ts
// Written against exports that exist on main (no new import), so it runs unchanged against the OLD source for the before-fail evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applyCorrections, applyReviewedDraft, buildResearch, fromStored, heldIds, offerId, offerIds, targetingFor, toStored, OFFER_QUESTION, WHO_QUESTION, type FetchedPage, type SellerResearch } from '../lib/scan/seller-research.ts'
import { normalizeResearch, type Icp } from '../lib/scan/icp.ts'
import { norm } from '../lib/scan/evidence.ts'
import { holdNameOf } from '../lib/scan/offer-identity.ts'
import { assembleDecisionPack, decisionRows, reuseSellerDecisions, type SellerDecision } from '../lib/scan/intelligence.ts'
import { reviewedBuyerTitles } from '../lib/enrich/index.ts'
import { captureSellerDecisions, createJob, migrateScan } from '../lib/scan/store.ts'

const STARTER = 'Enterprise customer relationship management Starter', PRO = 'Enterprise customer relationship management Pro'
const SITE = 'crm.example', ANSWER = 'Small independent retailers', EDITED = 'Enterprise sales VPs'
const PAGES: FetchedPage[] = [{ url: 'https://crm.example/', kind: 'home', title: 'CRM', text: 'Enterprise customer relationship management for retailers and distributors, with a Starter plan and a Pro plan.', fetched_at: 1800000000 }]
// Every offer is given the SAME three model statements: an id that moves between offers then also moves a correction onto an identical-looking statement.
const item = (offer: string, kind: string, text: string) => ({ offer, kind, text, url: PAGES[0].url, quote: '', inferred: true })
const model = (names: string[]) => ({ offers: names.map((n, i) => ({ id: `o${i + 1}`, name: n })), items: names.flatMap((_, i) => [item(`o${i + 1}`, 'persona', 'Retail operations managers'), item(`o${i + 1}`, 'industry', 'Retail'), item(`o${i + 1}`, 'disqualifier', 'Agencies')]) })
const build = (names: string[], prior?: SellerResearch | null, site = SITE): SellerResearch => { const r = buildResearch(model(names), PAGES, site, prior); if ('error' in r) throw new Error('setup'); return r }
const idOf = (r: SellerResearch, name: string) => r.offers.find(o => o.name === name)!.id
const hyp = (r: SellerResearch, name: string, kind: string, text?: string) => r.hypotheses.find(h => h.offer === idOf(r, name) && h.kind === kind && (!text || h.text === text))!
const roundTrip = (r: SellerResearch): SellerResearch => fromStored(normalizeResearch(JSON.parse(JSON.stringify(toStored(r))))!)
const who = (r: SellerResearch, name: string) => targetingFor(r, idOf(r, name)).who

// ---- the stored shape the OLD scheme wrote (positional ids), built by hand so it stays a fixed fixture ----
const legacyHyp = (offer: string, kind: string, text: string) => { let h = 5381; const s = `${offer}|${kind}|${norm(text)}`; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return `${offer}:${kind}:${h.toString(36)}` }
const BASE40 = 'enterprise-customer-relationship-managem'
// Old-scheme research for the given offers: the three model statements each; `answered` = the offer whose typed answer is stored; `edited` = the offer whose persona
// the person edited; `rejected` = the offer whose industry was rejected. Only what the old code could have written.
function legacyState(offers: { id: string; name: string }[], o: { answered: string; edited: string; rejected: string }): SellerResearch {
  const H = (offer: string, kind: string, text: string, shown: string, status: 'hypothesis' | 'reviewed' | 'rejected') => ({ id: legacyHyp(offer, kind, text), offer, kind: kind as 'persona', text: shown, status, url: null, quote: null, fetched_at: null })
  const hs = offers.flatMap(({ id, name }) => [{ id: `${id}:offer`, offer: id, kind: 'offer' as const, text: name, status: 'hypothesis' as const, url: null, quote: null, fetched_at: null },
    H(id, 'persona', 'Retail operations managers', o.edited === id ? EDITED : 'Retail operations managers', o.edited === id ? 'reviewed' : 'hypothesis'),
    H(id, 'industry', 'Retail', 'Retail', o.rejected === id ? 'rejected' : 'hypothesis'), H(id, 'disqualifier', 'Agencies', 'Agencies', 'hypothesis')])
  hs.push(H(o.answered, 'persona', ANSWER, ANSWER, 'reviewed'))
  return { site: SITE, pages: [], offers, hypotheses: hs, question: null, answered: { question: WHO_QUESTION, offer: o.answered, text: ANSWER } }
}
// What a person's review of a [STARTER, PRO] read leaves behind, produced through the real functions.
function reviewed(): SellerResearch {
  const r0 = build([STARTER, PRO])
  const answered = { question: WHO_QUESTION, offer: idOf(r0, STARTER), text: ANSWER }
  const r1 = build([STARTER, PRO], { ...r0, answered })
  const corrected = applyCorrections(r1, [
    { offer: idOf(r1, PRO), hypothesis: hyp(r1, PRO, 'persona', 'Retail operations managers').id, action: 'edit', value: EDITED },
    { offer: idOf(r1, STARTER), hypothesis: hyp(r1, STARTER, 'industry').id, action: 'reject' },
  ])
  return { ...corrected, answered }
}
// The assertions every "same offer keeps its own corrections after the listing order flips" case shares.
function assertSplit(r2: SellerResearch, label: string) {
  assert.equal(r2.answered?.offer, idOf(r2, STARTER), `${label}: the answer stays bound to STARTER`)
  assert.ok(who(r2, STARTER).includes(ANSWER), `${label}: STARTER keeps its reviewed buyer`)
  assert.ok(!who(r2, PRO).includes(ANSWER), `${label}: PRO never receives STARTER's buyer`)
  assert.ok(who(r2, PRO).includes(EDITED) && !who(r2, STARTER).includes(EDITED), `${label}: PRO's edit stays on PRO only`)
  assert.equal(hyp(r2, STARTER, 'industry').status, 'rejected', `${label}: STARTER's rejection stays on STARTER`)
  assert.notEqual(hyp(r2, PRO, 'industry').status, 'rejected', `${label}: PRO's industry is not rejected by STARTER's rejection`)
  assert.equal(hyp(r2, STARTER, 'persona', 'Retail operations managers').status, 'hypothesis', `${label}: STARTER's own model persona was never edited`)
}

test('#874 reversed colliding long names: the answered persona and edited/rejected hypotheses stay on their own offer (storage round trip)', () => {
  const r1 = reviewed()
  assert.notEqual(idOf(r1, STARTER), idOf(r1, PRO), 'two distinct names never share an id')
  for (const n of [STARTER, PRO]) assert.match(idOf(r1, n), /^[a-z0-9][a-z0-9-]*$/); for (const n of [STARTER, PRO]) assert.ok(idOf(r1, n).length <= 40, 'fits the stored id width')
  const r2 = build([PRO, STARTER], roundTrip(r1))
  assert.equal(idOf(r2, STARTER), idOf(r1, STARTER), 'identity does not depend on listing order'); assert.equal(idOf(r2, PRO), idOf(r1, PRO))
  assertSplit(r2, 'reversed')
  assertSplit(build([STARTER, PRO], roundTrip(r2)), 'reversed back')
})

test('#874 old-scheme state, colliding long names: storage kept ONE shared id for both offers, so the correction holds instead of moving', () => {
  // Exactly what the old code persisted: positional ids '...managem' and '...managem-2', cut to 40 characters by storage (icp.ts), i.e. the same id twice.
  const stored = roundTrip(legacyState([{ id: BASE40, name: STARTER }, { id: `${BASE40}-2`, name: PRO }], { answered: BASE40, edited: `${BASE40}-2`, rejected: BASE40 }))
  assert.equal(stored.offers[0].id, stored.offers[1].id, 'fixture check: storage really collapsed the two ids')
  for (const order of [[PRO, STARTER], [STARTER, PRO]]) {
    const r2 = build(order, stored)
    assert.equal(r2.answered, null, `${order[0]} first: the answer cannot be attributed, so it is not carried`)
    assert.ok(!who(r2, STARTER).includes(ANSWER) && !who(r2, PRO).includes(ANSWER), 'neither offer receives the typed buyer')
    assert.ok(!who(r2, STARTER).includes(EDITED) && !who(r2, PRO).includes(EDITED), 'neither offer receives the edited persona')
    // the rejection could not be attributed: it is HELD (kept, and honoured on both candidates), never dropped and never moved onto a guessed offer
    assert.equal(hyp(r2, STARTER, 'industry').status, 'rejected'); assert.equal(hyp(r2, PRO, 'industry').status, 'rejected')
    assert.ok((r2.unresolved ?? []).length >= 3, 'the answer, the edited persona and the rejection are all kept as unresolved decisions')
    assert.deepEqual([...heldIds(r2)].sort(), [idOf(r2, STARTER), idOf(r2, PRO)].sort(), 'both candidate offers are held')
    assert.ok(r2.question !== null, 'the person is asked again')
  }
})

test('#874 old-scheme state whose ids survived storage (short-slug collision "Café Pro" / "Caf Pro"): corrections follow the NAME across a flip', () => {
  const [a, b] = ['Café Pro', 'Caf Pro']
  const stored = roundTrip(legacyState([{ id: 'caf-pro', name: a }, { id: 'caf-pro-2', name: b }], { answered: 'caf-pro', edited: 'caf-pro-2', rejected: 'caf-pro' }))
  assert.deepEqual(stored.offers.map(o => o.id), ['caf-pro', 'caf-pro-2'], 'fixture check: these ids survive storage')
  for (const order of [[b, a], [a, b]]) {
    const r2 = build(order, stored)
    assert.equal(r2.answered?.offer, idOf(r2, a), `${order[0]} first: the answer stays with ${a}`)
    assert.ok(who(r2, a).includes(ANSWER) && !who(r2, b).includes(ANSWER) && who(r2, b).includes(EDITED) && !who(r2, a).includes(EDITED))
    assert.equal(hyp(r2, a, 'industry').status, 'rejected'); assert.notEqual(hyp(r2, b, 'industry').status, 'rejected')
    assert.deepEqual(r2.unresolved ?? [], [], 'unambiguous: nothing is held')
  }
})

test('#874 control: old-scheme state with a unique long name keeps its corrections through a flip and an id change', () => {
  const stored = roundTrip(legacyState([{ id: BASE40, name: STARTER }, { id: 'booking', name: 'Booking' }], { answered: BASE40, edited: 'booking', rejected: BASE40 }))
  for (const order of [['Booking', STARTER], [STARTER, 'Booking']]) {
    const r2 = build(order, stored)
    assert.equal(r2.answered?.offer, idOf(r2, STARTER)); assert.ok(who(r2, STARTER).includes(ANSWER) && !who(r2, 'Booking').includes(ANSWER) && who(r2, 'Booking').includes(EDITED) && !who(r2, STARTER).includes(EDITED))
    assert.equal(hyp(r2, STARTER, 'industry').status, 'rejected'); assert.notEqual(hyp(r2, 'Booking', 'industry').status, 'rejected'); assert.equal(idOf(r2, 'Booking'), 'booking')
  }
})

test('#874 applyCorrections: corrections made against one read never land on the other offer after the order flips', () => {
  const r1 = reviewed()
  const edit = [{ offer: idOf(r1, STARTER), hypothesis: hyp(r1, STARTER, 'persona', 'Retail operations managers').id, action: 'edit' as const, value: 'Starter-only buyer' }]
  const r2 = applyCorrections(build([PRO, STARTER], roundTrip(r1)), edit)
  assert.ok(who(r2, STARTER).includes('Starter-only buyer'), 'the correction applies to STARTER'); assert.ok(!who(r2, PRO).includes('Starter-only buyer'), 'and never to PRO, whose model statement reads identically')
})

test('#874 applyReviewedDraft (reviewed draft merge): binds the play offer\'s own saved offer, for new-scheme and legacy stored state alike', () => {
  const icp = (r: SellerResearch): Icp => ({ summary: 's', who: [ANSWER, EDITED], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(r) })
  const r2 = build([PRO, STARTER], roundTrip(reviewed()))
  for (const [play, other] of [[PRO, STARTER], [STARTER, PRO]] as const) {
    const out = applyReviewedDraft(icp(r2), play)
    assert.equal(out.research!.ans?.o, idOf(r2, STARTER), `playing ${play}: the typed answer stays STARTER's`)
    const st = fromStored(out.research!)
    assert.deepEqual(st.hypotheses.filter(h => h.offer === idOf(r2, other)).map(h => [h.id, h.status, h.text]), r2.hypotheses.filter(h => h.offer === idOf(r2, other)).map(h => [h.id, h.status, h.text]), `playing ${play}: the other offer's statements are untouched`)
  }
  // a play named for one of two short-slug colliders, against old positional state whose ids survived storage, binds that offer's saved entry by name
  const stored = roundTrip(legacyState([{ id: 'caf-pro', name: 'Café Pro' }, { id: 'caf-pro-2', name: 'Caf Pro' }], { answered: 'caf-pro', edited: 'caf-pro-2', rejected: 'caf-pro' }))
  const draft = (offer: string) => applyReviewedDraft({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: { ...toStored({ ...stored, answered: null, question: OFFER_QUESTION }) } }, offer).research!.ans?.o ?? null
  assert.equal(draft('Caf Pro'), 'caf-pro-2'); assert.equal(draft('Café Pro'), 'caf-pro')
  // colliding long names whose saved ids collapsed to one: nothing can be bound, the draft passes through untouched
  const collapsed = roundTrip(legacyState([{ id: BASE40, name: STARTER }, { id: `${BASE40}-2`, name: PRO }], { answered: BASE40, edited: `${BASE40}-2`, rejected: BASE40 }))
  for (const play of [STARTER, PRO]) assert.equal(applyReviewedDraft({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored({ ...collapsed, answered: null, question: OFFER_QUESTION }) }, play).research!.ans, null, `${play}: held`)
})

const COLLIDING: [string, string][] = [['Café Pro', 'Caf Pro'], ['Pro!', 'Pro?'], ['日本語 Starter', '中文 Starter'], ['日本語', '中文']]
test('#874 punctuation / non-ASCII names that normalize to the same slug are different offers and keep their own answers when reordered', () => {
  for (const [a, b] of COLLIDING) {
    const r0 = build([a, b]); assert.notEqual(idOf(r0, a), idOf(r0, b), `${a} / ${b}: distinct ids`)
    const r1 = build([a, b], { ...r0, answered: { question: WHO_QUESTION, offer: idOf(r0, a), text: ANSWER } })
    const r2 = build([b, a], roundTrip(r1))
    assert.equal(r2.answered?.offer, idOf(r2, a), `${a} / ${b}: the answer stays with ${a}`); assert.ok(who(r2, a).includes(ANSWER) && !who(r2, b).includes(ANSWER), `${a} / ${b}: ${b} gets nothing`)
    assert.equal(idOf(r2, a), idOf(r1, a), `${a} / ${b}: order does not change ${a}'s id`)
  }
})

test('#874 same-name ambiguity holds: saved answers and corrections bind to neither of two offers with the same name, in either direction', () => {
  const r0 = build(['Booking', 'Booking'])
  const prior = { ...r0, answered: { question: WHO_QUESTION, offer: r0.offers[0].id, text: ANSWER } }
  const dup = build(['Booking', 'Booking'], roundTrip(prior))
  assert.equal(dup.answered, null, 'two listed offers of one name: the answer is held'); assert.ok(dup.offers[0].id !== dup.offers[1].id, 'they still get distinct ids')
  assert.ok(dup.offers.every(o => !targetingFor(dup, o.id).who.includes(ANSWER)), 'neither gets the buyer')
  // the answer was given when there was ONE Booking; now two are listed
  const one = build(['Booking']); const answeredOne = { ...one, answered: { question: WHO_QUESTION, offer: one.offers[0].id, text: ANSWER } }
  const nowTwo = build(['Booking', 'Booking'], roundTrip(build(['Booking'], answeredOne)))
  assert.equal(nowTwo.answered, null); assert.ok(nowTwo.offers.every(o => !targetingFor(nowTwo, o.id).who.includes(ANSWER)))
  // the saved state itself lists two Booking offers; now one is listed
  const savedTwo = roundTrip({ ...r0, answered: { question: WHO_QUESTION, offer: r0.offers[0].id, text: ANSWER } })
  const nowOne = build(['Booking'], savedTwo); assert.equal(nowOne.answered, null); assert.ok(!targetingFor(nowOne, nowOne.offers[0].id).who.includes(ANSWER))
})

test('#874 two long names that agree through the 60 stored characters cannot be told apart in storage: the correction holds, it does not move', () => {
  const X = 'Enterprise customer relationship management platform for retail', A = `${X} Starter edition`, B = `${X} Pro edition`
  assert.equal(A.slice(0, 60), B.slice(0, 60)); assert.ok(A.length > 60)
  const r0 = build([A, B]); const r1 = build([A, B], { ...r0, answered: { question: WHO_QUESTION, offer: idOf(r0, A), text: ANSWER } })
  const r2 = build([B, A], roundTrip(r1))
  assert.equal(r2.answered, null, 'held'); assert.ok(r2.offers.every(o => !targetingFor(r2, o.id).who.includes(ANSWER)), 'neither offer receives the buyer'); assert.ok(r2.question !== null, 'the person is asked again')
})

// ---- negative controls: these behaviours must be unchanged by the fix ----
test('#874 control: an unchanged rerun, in the same order, carries everything', () => {
  const r1 = reviewed(); const r2 = build([STARTER, PRO], roundTrip(r1)); assertSplit(r2, 'unchanged rerun')
})
test('#874 control: a removed offer\'s answer is dropped; the remaining offer keeps only its own corrections (short names)', () => {
  const r0 = build(['Booking', 'Payroll']); const r1 = build(['Booking', 'Payroll'], { ...r0, answered: { question: WHO_QUESTION, offer: idOf(r0, 'Booking'), text: ANSWER } })
  const gone = build(['Payroll'], roundTrip(r1)); assert.equal(gone.answered, null); assert.ok(!targetingFor(gone, idOf(gone, 'Payroll')).who.includes(ANSWER))
  const kept = build(['Booking'], roundTrip(r1)); assert.equal(kept.answered?.text, ANSWER); assert.ok(targetingFor(kept, idOf(kept, 'Booking')).who.includes(ANSWER))
})
test('#874 a removed LONG-name offer\'s answer is dropped too, not handed to the offer that is left', () => {
  const r1 = reviewed(); const onlyPro = build([PRO], roundTrip(r1))
  assert.equal(onlyPro.answered, null); assert.ok(!who(onlyPro, PRO).includes(ANSWER)); assert.ok(who(onlyPro, PRO).includes(EDITED), 'PRO keeps its own edit')
})
test('#874 control: another site\'s saved answers and corrections never carry, even for identical offer names', () => {
  const other = build([STARTER, PRO], roundTrip(reviewed()), 'other.example')
  assert.equal(other.answered, null); assert.ok(!who(other, STARTER).includes(ANSWER) && !who(other, PRO).includes(EDITED))
  const r = reviewed(); const mixed = build([STARTER, PRO], { ...roundTrip(r), site: 'other.example' }); assert.equal(mixed.answered, null)
})
test('#874 control: another play (offer) in the reviewed draft is untouched, and rejection precedence still removes a rejected statement\'s text', () => {
  const r = build([STARTER, PRO], roundTrip(reviewed()))   // same order: the control isolates rejection precedence from the flip
  const icp: Icp = { summary: 's', who: [ANSWER, 'Retail operations managers'], industries: ['Retail'], sizes: [], where: [], signals: [], exclude: [], research: toStored(r) }
  const playStarter = applyReviewedDraft(icp, STARTER)
  assert.deepEqual(playStarter.industries, [], 'STARTER rejected Retail: it leaves the effective industries'); assert.deepEqual(applyReviewedDraft(icp, PRO).industries, ['Retail'], 'PRO never rejected it')
  assert.equal(fromStored(applyReviewedDraft(icp, PRO).research!).hypotheses.find(h => h.offer === idOf(r, STARTER) && h.kind === 'industry')!.status, 'rejected', 'STARTER\'s rejection stays recorded while PRO is played')
})
test('#874 control: short-name behaviour is unchanged (plain slug ids, same hypothesis ids)', () => {
  const r = build(['Acme Booking', 'Acme Payroll']); assert.deepEqual(r.offers.map(o => o.id), ['acme-booking', 'acme-payroll']); assert.equal(offerId('Acme Booking'), 'acme-booking'); assert.equal(offerId(''), 'offer')
  assert.equal(hyp(r, 'Acme Booking', 'persona').id, legacyHyp('acme-booking', 'persona', 'Retail operations managers'), 'hypothesis ids for short names are bit-for-bit the old ones')
})

// ---- consumers of the stored corrections: retrieval titles and the targeting merge ----
function jobDb(research: SellerResearch, offerName: string, decisions: ReturnType<typeof decisionRows>) {
  const db = new Database(':memory:'); migrateScan(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, offer = ? WHERE id = ?").run(JSON.stringify({ who: [], research: normalizeResearch(JSON.parse(JSON.stringify(toStored(research)))) }), offerName, jobId)
  captureSellerDecisions(db, decisions.map(d => ({ ...d, job_id: jobId })))
  return { db, jobId }
}
const scope = { tenant: 'u1', actor: 'a1', job: 'j0', now: 1800000000000 }
test('#874 consumers: reviewed buyer titles for retrieval and the targeting merge follow the offer after the order flips', () => {
  const r1 = reviewed()
  const profile: Icp = { summary: 's', who: [ANSWER], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(r1) }
  const answerHyp = r1.hypotheses.find(h => h.offer === idOf(r1, STARTER) && h.kind === 'persona' && h.text === ANSWER)!
  const rows = decisionRows([{ offer: idOf(r1, STARTER), hypothesis: answerHyp.id, action: 'confirm' }], profile.research, scope, profile)
  const r2 = build([PRO, STARTER], roundTrip(r1))
  // retrieval: the buyer titles sent to the provider for each play
  const starterJob = jobDb(r2, STARTER, rows), proJob = jobDb(r2, PRO, rows)
  assert.deepEqual(reviewedBuyerTitles(starterJob.db, starterJob.jobId), [ANSWER], 'the STARTER play retrieves with STARTER\'s confirmed buyer')
  assert.deepEqual(reviewedBuyerTitles(proJob.db, proJob.jobId), [], 'the PRO play does not inherit it')
  // targeting merge (ranking input): the flat draft each play gets
  const pack = assembleDecisionPack(rows.map(d => ({ ...d })), 'u1', SITE)
  const icp2: Icp = { summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(r2) }
  assert.deepEqual(reuseSellerDecisions(icp2, pack, STARTER).who, [ANSWER]); assert.deepEqual(reuseSellerDecisions(icp2, pack, PRO).who, [])
})


// =====================================================================================================================================================
// Review round 1 on #1000: (1) unresolved identity is a persisted, fail-closed HOLD, (2) already-saved seller_decisions rows are rebound or held through both real consumers,
// (3) one identity contract (the STORED name) across construction, storage, reviewed draft, retrieval titles and decision reuse.
// =====================================================================================================================================================
const QUOTE_PAGES: FetchedPage[] = [{ url: 'https://crm.example/', kind: 'home', title: 'CRM', text: 'Enterprise customer relationship management for retailers and distributors, with a Starter plan and a Pro plan.', fetched_at: 1800000000 }]
// A SOURCED statement: a verbatim quote that carries the claim. This is the statement a person once rejected and a fresh read now supports again.
const SOURCED = { kind: 'industry', text: 'retailers and distributors', quote: 'for retailers and distributors' }
const buildSourced = (names: string[], prior?: SellerResearch | null): SellerResearch => {
  const m = { offers: names.map((n, i) => ({ id: `o${i + 1}`, name: n })), items: names.map((_, i) => ({ offer: `o${i + 1}`, kind: SOURCED.kind, text: SOURCED.text, url: QUOTE_PAGES[0].url, quote: SOURCED.quote, inferred: false })) }
  const r = buildResearch(m, QUOTE_PAGES, SITE, prior); if ('error' in r) throw new Error('setup'); return r
}
const industries = (r: SellerResearch, name: string) => targetingFor(r, idOf(r, name)).industries

test('#874 held identity is a PERSISTED, fail-closed state: a previously rejected claim that a fresh quote supports again is not targeted until the person reviews it', () => {
  // The old run stored a REJECTION of 'retailers and distributors' for one of two colliding long-name offers; storage collapsed their ids, so whose it was is lost.
  const legacy = legacyState([{ id: BASE40, name: STARTER }, { id: `${BASE40}-2`, name: PRO }], { answered: BASE40, edited: `${BASE40}-2`, rejected: BASE40 })
  legacy.hypotheses = legacy.hypotheses.map(h => h.kind === 'industry' ? { ...h, text: SOURCED.text } : h)   // the rejected statement is the one the page supports
  const stored = roundTrip(legacy)
  const r2 = buildSourced([PRO, STARTER], stored)
  for (const n of [STARTER, PRO]) {
    assert.equal(hyp(r2, n, 'industry', SOURCED.text).status, 'rejected', `${n}: the unattributable rejection is honoured, the fresh quote does not resurrect it`)
    assert.deepEqual(industries(r2, n), [], `${n}: and it is not used for targeting`)
  }
  // The hold survives storage and the next rerun (it is not just an unanswered question):
  const again = buildSourced([STARTER, PRO], roundTrip(r2))
  assert.ok((again.unresolved ?? []).length >= 3, 'persisted through toStored/normalizeResearch/fromStored and carried to the next rerun')
  for (const n of [STARTER, PRO]) assert.deepEqual(industries(again, n), [])
  // A statement the model supports that nobody ever decided on is held too (only explicit review targets for a held offer):
  const other = legacyState([{ id: BASE40, name: STARTER }, { id: `${BASE40}-2`, name: PRO }], { answered: BASE40, edited: `${BASE40}-2`, rejected: BASE40 })   // its rejection is about 'Retail', not the quoted claim
  const fresh = buildSourced([STARTER, PRO], roundTrip(other))
  assert.ok(fresh.hypotheses.some(h => h.status === 'sourced' && h.kind === 'industry'), 'fixture check: the page-supported claim is sourced')
  for (const n of [STARTER, PRO]) assert.deepEqual(industries(fresh, n), [], `${n}: sourced alone does not target while the offer is held`)
  // Control: with no prior at all, the same claim is sourced and targeted.
  assert.deepEqual(industries(buildSourced([STARTER, PRO]), STARTER), [SOURCED.text])
})

const legacyPair = (): SellerResearch => { const l = legacyState([{ id: BASE40, name: STARTER }, { id: `${BASE40}-2`, name: PRO }], { answered: BASE40, edited: `${BASE40}-2`, rejected: BASE40 }); l.hypotheses = l.hypotheses.map(h => h.kind === 'industry' ? { ...h, text: SOURCED.text } : h); return l }
// only the rejection is unresolved: every other saved decision is removed, so the candidates' ONLY hold is that one entry
const legacyRejectionOnly = (): SellerResearch => { const l = legacyPair(); return { ...l, answered: null, hypotheses: l.hypotheses.filter(h => h.status !== 'reviewed') } }
const holds = (r: SellerResearch, name: string) => heldIds(r).includes(idOf(r, name))
const decide = (r: SellerResearch, name: string, kind: string, action: 'confirm' | 'reject' = 'reject') => applyCorrections(r, r.hypotheses.filter(h => h.offer === idOf(r, name) && h.kind === kind).map(h => ({ offer: h.offer, hypothesis: h.id, action })))
test('#874 a hold is released per CANDIDATE: deciding for A leaves B held through storage and reruns, until B\'s own explicit decision', () => {
  let r = buildSourced([STARTER, PRO], roundTrip(legacyRejectionOnly())); assert.ok(holds(r, STARTER) && holds(r, PRO))
  r = buildSourced([STARTER, PRO], roundTrip(r)); assert.ok(holds(r, STARTER) && holds(r, PRO), 'a plain rerun releases neither')
  const a = decide(r, STARTER, 'industry')   // the person explicitly re-decides STARTER's statement the unresolved rejection was about
  assert.ok(!holds(a, STARTER), 'STARTER\'s share of that entry is released')
  assert.ok(holds(a, PRO), 'PRO is still held right after STARTER was decided')
  // persisted rerun: PRO still held, and a NEWLY sourced statement does not become PRO targeting
  const m = { offers: [STARTER, PRO].map((n, i) => ({ id: `o${i + 1}`, name: n })), items: [STARTER, PRO].flatMap((_, i) => [{ offer: `o${i + 1}`, kind: SOURCED.kind, text: SOURCED.text, url: QUOTE_PAGES[0].url, quote: SOURCED.quote, inferred: false }, { offer: `o${i + 1}`, kind: 'industry', text: 'distributors', url: QUOTE_PAGES[0].url, quote: 'retailers and distributors', inferred: false }]) }
  const again = buildResearch(m, QUOTE_PAGES, SITE, roundTrip(a)); if ('error' in again) throw new Error('setup')
  assert.ok(holds(again, PRO), 'PRO is still held after a persisted rerun')
  assert.ok(!industries(again, PRO).includes('distributors'), 'a newly sourced statement is not PRO targeting while PRO is held')
  // control: PRO's own explicit decision releases PRO's share
  const both = decide(again, PRO, 'industry')
  assert.ok(!holds(both, PRO) && !holds(both, STARTER) && !(both.unresolved ?? []).length, 'after both candidates decided, the entry is gone')
})
test('#874 typed-answer release is candidate-scoped too: answering for A does not release B\'s share of a multi-candidate answer entry', () => {
  const r0 = buildSourced([STARTER, PRO], roundTrip(legacyPair())); assert.ok((r0.unresolved ?? []).some(u => u.kind === 'persona' && u.status === 'reviewed' && u.text === ANSWER && u.names.length === 2), 'fixture: one answer entry, two candidates')
  const answeredA = { question: WHO_QUESTION, offer: idOf(r0, STARTER), text: ANSWER }
  const r1 = buildSourced([STARTER, PRO], { ...roundTrip(r0), answered: answeredA })
  const entry = (r1.unresolved ?? []).find(u => u.kind === 'persona' && u.text === ANSWER)
  assert.deepEqual(entry?.names, [holdNameOf(PRO)], 'only PRO remains a candidate for the answer entry')
  assert.ok(holds(r1, PRO), 'PRO stays held'); assert.ok(!(r1.unresolved ?? []).some(u => u.names.includes(holdNameOf(STARTER)) && u.text === ANSWER), 'STARTER\'s share of the answer entry is released')
})
test('#874 hold names are one canonical spelling on write AND read: saved ambiguous rows -> reuse -> storage -> fromStored -> heldIds/targetingFor, in mixed case, width and controls', () => {
  const names = ['Café Pro', 'Caf Pro']
  const base = build(names), rows = [row('caf-pro', 'Owner B', 'reject', { at: 200 }), row('caf-pro', 'Owner A', 'confirm', { at: 100 })]
  const out = reuseSellerDecisions({ summary: 's', who: ['Owner A', 'Owner B'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(base) }, assembleDecisionPack(rows, T, SITE), names[0])
  const persisted = fromStored(normalizeResearch(JSON.parse(JSON.stringify(out.research)))!)
  assert.deepEqual(heldIds(persisted).sort(), persisted.offers.map(o => o.id).sort(), 'both candidates are held after reuse + storage + fromStored')
  for (const n of names) assert.deepEqual(targetingFor(persisted, idOf(persisted, n)).who, [], `${n}: held, nothing merely sourced targets`)
  // the same hold, written in other spellings, still resolves to the same offers
  for (const spelling of [['CAFÉ PRO', 'CAF PRO'], ['cafe\u0301  pro', 'caf\u0000 pro'], ['Ｃａｆé Ｐｒｏ', 'Ｃａｆ Ｐｒｏ']]) {
    const w = { ...base, unresolved: [{ names: spelling, kind: 'persona' as const, text: 'x', status: 'reviewed' as const }] }
    const back = fromStored(normalizeResearch(JSON.parse(JSON.stringify(toStored(w))))!)
    assert.equal(heldIds(back).length, names.length === 2 && spelling[0].toLowerCase().includes('cafe') ? 2 : heldIds(back).length, JSON.stringify(spelling))
    assert.ok(heldIds(back).includes(idOf(back, names[1])), `${JSON.stringify(spelling)}: the plain "Caf Pro" is held`)
  }
  // a newly sourced statement does not become targeting merely because the hold was spelled differently
  const sourced = buildSourced(names, { ...persisted, unresolved: persisted.unresolved!.map(u => ({ ...u, names: u.names.map(n => n.toUpperCase()) })) })
  for (const n of names) assert.deepEqual(industries(sourced, n), [], `${n}: still not targeting`)
})

// ---- already-saved seller_decisions rows, through real storage and both real consumers ----
const T = 'u1', ACTOR = 'a1'
let rowClock = 1000
const row = (offer_id: string, text: string, action: 'confirm' | 'reject', o: { site?: string; tenant?: string; at?: number } = {}): SellerDecision => ({ id: `r${rowClock}`, tenant_id: o.tenant ?? T, actor_id: ACTOR, job_id: 'j0', site: o.site ?? SITE, offer_id, hypothesis_id: `h-${rowClock++}`, kind: 'persona', text, action, source_url: null, source_quote: null, source_checked_at: null, created_at: o.at ?? rowClock * 10, version: 1 })
function stored(research: SellerResearch, rows: SellerDecision[], playOffer: string) {
  const db = new Database(':memory:'); migrateScan(db)
  const jobId = createJob(db, T, { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, offer = ? WHERE id = ?").run(JSON.stringify({ who: [], research: normalizeResearch(JSON.parse(JSON.stringify(toStored(research)))) }), playOffer, jobId)
  captureSellerDecisions(db, rows.map(r => ({ ...r, job_id: jobId })))
  const saved = db.prepare('SELECT id,tenant_id,actor_id,job_id,site,offer_id,hypothesis_id,kind,text,action,source_url,source_quote,source_checked_at,created_at,version FROM seller_decisions WHERE tenant_id = ? AND site = ? ORDER BY created_at DESC, action DESC, id DESC').all(T, SITE) as SellerDecision[]
  const icp = JSON.parse((db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string }).icp) as { research: ReturnType<typeof toStored> }
  const flat = (who: string[]): Icp => ({ summary: 's', who, industries: [], sizes: [], where: [], signals: [], exclude: [], research: icp.research })
  return { titles: () => reviewedBuyerTitles(db, jobId), reuse: (who: string[] = []) => reuseSellerDecisions(flat(who), assembleDecisionPack(saved, T, SITE), playOffer) }
}
const LONG = 'Enterprise customer relationship management Starter'   // 51 chars: stored whole; its legacy id is the 40-char prefix
test('#874 saved decisions, unique long-name offer: rows saved under the OLD id are rebound to it by name (confirm, edit-as-confirm and reject), through both consumers', () => {
  const r = build([LONG]); assert.notEqual(idOf(r, LONG), BASE40, 'the id changed')
  const s = stored(r, [row(BASE40, 'VP Retail', 'confirm', { at: 100 }), row(BASE40, 'Head of Ops', 'confirm', { at: 200 }), row(BASE40, 'Head of Ops', 'reject', { at: 300 })], LONG)
  assert.deepEqual(s.titles(), ['VP Retail'], 'retrieval titles: the confirmation survives, the newer rejection of the other title wins')
  const out = s.reuse(['Head of Ops', 'Buyer X'])
  assert.deepEqual(out.who, ['Buyer X', 'VP Retail'], 'decision reuse: confirmed text added, rejected text removed (rejection precedence)')
})
test('#874 saved decisions, colliding short names: an old shared id is HELD (reject honoured on both, confirm applied to neither); a later hashed id rebinds when the companion leaves', () => {
  const [a, b] = ['Café Pro', 'Caf Pro']
  const both = build([a, b])
  const s = stored(both, [row('caf-pro', 'Owner A', 'confirm', { at: 100 }), row('caf-pro', 'Owner B', 'reject', { at: 200 })], a)
  assert.deepEqual(s.titles(), [], 'retrieval: the unattributable confirmation is applied to no offer')
  const out = s.reuse(['Owner A', 'Owner B'])
  assert.deepEqual(out.who, ['Owner A'], 'reuse: the confirmation is not added, the rejection removes its text, nothing moves to a guessed offer')
  assert.ok((out.research!.u ?? []).some(u => u.s === 'rejected' && u.t === 'Owner B'), 'and the held decision stays visible in the research block')
  // written while the companion existed (hashed id), read after it was removed (plain id again):
  const hashedA = offerIds([a, b]).ids[0]; assert.notEqual(hashedA, 'caf-pro')
  const alone = stored(build([a]), [row(hashedA, 'Owner A', 'confirm')], a)
  assert.equal(idOf(build([a]), a), 'caf-pro'); assert.deepEqual(alone.titles(), ['Owner A'], 'rebound by name to the offer it was written for')
})
test('#874 saved decisions: an old positional "-2" id, a removed offer, and another site/tenant are never carried to a guessed offer', () => {
  const r = build([STARTER, PRO])
  const s = stored(r, [row(`${BASE40}-2`, 'Pos buyer', 'confirm'), row('long-gone-offer', 'Gone buyer', 'confirm'), row(idOf(r, STARTER), 'Other site buyer', 'confirm', { site: 'other.example' }), row(idOf(r, STARTER), 'Other tenant buyer', 'confirm', { tenant: 'u2' })], STARTER)
  assert.deepEqual(s.titles(), [], 'nothing carried: the positional id is held, the removed offer and other site/tenant rows never match')
  assert.deepEqual(s.reuse([]).who, [])
  const own = stored(r, [row(idOf(r, STARTER), 'Own buyer', 'confirm')], STARTER)
  assert.deepEqual(own.titles(), ['Own buyer'], 'control: a row under the current id still applies'); assert.deepEqual(stored(r, [row(idOf(r, STARTER), 'Own buyer', 'confirm')], PRO).titles(), [], 'and never to the other play')
})

// ---- one identity contract: the STORED name, across storage, reviewed draft, titles and reuse ----
const N90 = 'Enterprise customer relationship management platform for independent regional retailers and distributors'   // > 60 chars
test('#874 identity contract: a unique name longer than 60 characters still matches its play after storage, in the reviewed draft AND both consumers', () => {
  assert.ok(N90.length > 60)
  const r = build([N90]), id = idOf(r, N90)
  const s = stored(r, [row(id, 'Buyer 90', 'confirm')], N90)
  assert.deepEqual(s.titles(), ['Buyer 90']); assert.deepEqual(s.reuse([]).who, ['Buyer 90'])
  const draft = applyReviewedDraft({ summary: 's', who: ['x'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: normalizeResearch(JSON.parse(JSON.stringify(toStored({ ...r, answered: null, question: OFFER_QUESTION })))) }, N90)
  assert.equal(draft.research!.ans?.o, id, 'the reviewed draft binds the same offer by the same stored-name contract')
})
test('#874 identity contract: two names equal through 60 characters select NOTHING in any consumer (play ambiguity), and a removed companion makes the survivor selectable again', () => {
  const X = 'Enterprise customer relationship management platform for retail'   // 63 chars
  const A = `${X} Starter edition`, B = `${X} Pro edition`; assert.equal(A.slice(0, 60), B.slice(0, 60))
  const r = build([A, B]); const s = stored(r, [row(idOf(r, A), 'Buyer A', 'confirm')], A)
  assert.deepEqual(s.titles(), []); assert.deepEqual(s.reuse(['Existing']).who, ['Existing'], 'draft passes through untouched')
  const alone = build([A]); assert.deepEqual(stored(alone, [row(idOf(alone, A), 'Buyer A', 'confirm')], A).titles(), ['Buyer A'])
})
test('#874 storage canonicalization: control characters / runs of spaces before the 60-character cap do not cost an identical rerun its answer', () => {
  const odd = `Acme${' '.repeat(60)}Booking`, ctrl = 'Acme\u0000\u0007 Booking'
  for (const name of [odd, ctrl]) {
    const r0 = build([name]); const r1 = build([name], { ...r0, answered: { question: WHO_QUESTION, offer: r0.offers[0].id, text: ANSWER } })
    const r2 = build([name], roundTrip(r1))
    assert.equal(r2.answered?.text, ANSWER, JSON.stringify(name)); assert.ok(who(r2, name).includes(ANSWER))
    assert.equal(stored(r2, [row(idOf(r2, name), 'Titled', 'confirm')], name).titles()[0], 'Titled')
  }
})
test('#874 the fix does not change what a person sees for a plain site: short unique names, no holds, same ids, same targeting', () => {
  const r = build(['Acme Booking', 'Acme Payroll']); assert.equal(r.unresolved, undefined); assert.deepEqual(heldIds(r), [])
  assert.deepEqual(roundTrip(r).unresolved, undefined)
  assert.deepEqual(targetingFor(r, 'acme-booking').who, [])
})


// ---- the ambiguous-name class: offers whose persisted hold NAME is the same (equal through the 60 stored characters, exact duplicates, case/width-equivalent) ----
const X60 = 'Enterprise customer relationship management platform for retail'   // 63 chars
const SAME60: [string, string][] = [[`${X60} Starter edition`, `${X60} Pro edition`], ['Booking', 'Booking'], ['Booking', 'BOOKING'], ['Ｂｏｏｋｉｎｇ', 'Booking']]
const heldFor = (names: [string, string]): SellerResearch => {   // an unresolved decision whose name is the shared key: it holds BOTH offers
  const base = build([...names]); return { ...base, unresolved: [{ names: [holdNameOf(names[0])], kind: 'industry', text: SOURCED.text, status: 'rejected' }] }
}
const extra = (names: [string, string], prior: SellerResearch): SellerResearch => {   // a rerun whose model also supplies statements nobody ever decided on
  const items = names.flatMap((_, i) => [{ offer: `o${i + 1}`, kind: SOURCED.kind, text: SOURCED.text, url: QUOTE_PAGES[0].url, quote: SOURCED.quote, inferred: false }, { offer: `o${i + 1}`, kind: 'industry', text: 'distributors', url: QUOTE_PAGES[0].url, quote: 'retailers and distributors', inferred: false }, { offer: `o${i + 1}`, kind: 'persona', text: 'retailers', url: QUOTE_PAGES[0].url, quote: 'for retailers and distributors', inferred: false }])
  const r = buildResearch({ offers: names.map((n, i) => ({ id: `o${i + 1}`, name: n })), items }, QUOTE_PAGES, SITE, prior); if ('error' in r) throw new Error('setup'); return r
}
for (const names of SAME60) {
  test(`#874 shared hold key (${JSON.stringify(names.map(n => n.slice(0, 14)))}): deciding for A alone never releases B; persisted, reloaded and rerun, B's unrelated sourced statements stay blocked`, () => {
    assert.equal(holdNameOf(names[0]), holdNameOf(names[1]), 'fixture: one shared hold key')
    const r = extra(names, roundTrip(heldFor(names)))
    const [A, B] = r.offers.map(o => o.id); assert.notEqual(A, B)
    assert.deepEqual([...heldIds(r)].sort(), [A, B].sort(), 'both are held')
    assert.ok(r.hypotheses.some(h => h.offer === B && h.status === 'sourced' && h.kind === 'industry'), 'fixture: B has a sourced statement nobody reviewed')
    // decide ONLY A on the held statement
    const afterA = applyCorrections(r, r.hypotheses.filter(h => h.offer === A && h.kind === 'industry' && norm(h.text) === norm(SOURCED.text)).map(h => ({ offer: A, hypothesis: h.id, action: 'reject' as const })))
    assert.deepEqual([...heldIds(afterA)].sort(), [A, B].sort(), 'deciding A does not release the shared group')
    // save, reload, rerun with new sourced statements
    const again = extra(names, roundTrip(afterA))
    assert.deepEqual([...heldIds(again)].sort(), again.offers.map(o => o.id).sort(), 'still held after reload and rerun')
    for (const o of again.offers) { const tg = targetingFor(again, o.id); assert.deepEqual([tg.industries, tg.who], [[], []], `${o.name.slice(0, 20)}: no merely-sourced statement targets`) }
    // control: only when EVERY offer in the group has its own explicit decision on the statement is the group released
    const both = applyCorrections(again, again.offers.flatMap(o => again.hypotheses.filter(h => h.offer === o.id && h.kind === 'industry' && norm(h.text) === norm(SOURCED.text)).map(h => ({ offer: o.id, hypothesis: h.id, action: 'reject' as const }))))
    assert.deepEqual(heldIds(both), [], 'every candidate decided: released')
  })
}
test('#874 shared hold key: a typed answer for one offer id does not release a group it cannot tell apart', () => {
  const names: [string, string] = SAME60[0]
  const base = build([...names]), held: SellerResearch = { ...base, unresolved: [{ names: [holdNameOf(names[0])], kind: 'persona', text: ANSWER, status: 'reviewed' }] }
  const r = build([...names], { ...roundTrip(held), answered: { question: WHO_QUESTION, offer: base.offers[0].id, text: ANSWER } })
  assert.deepEqual([...heldIds(r)].sort(), r.offers.map(o => o.id).sort(), 'both stay held')
  // control: a distinct-name candidate IS released by its own answer
  const d = build(['Alpha Pro', 'Beta Pro']), dh: SellerResearch = { ...d, unresolved: [{ names: [holdNameOf('Alpha Pro'), holdNameOf('Beta Pro')], kind: 'persona', text: ANSWER, status: 'reviewed' }] }
  const dr = build(['Alpha Pro', 'Beta Pro'], { ...roundTrip(dh), answered: { question: WHO_QUESTION, offer: d.offers[0].id, text: ANSWER } })
  assert.deepEqual(heldIds(dr), [idOf(dr, 'Beta Pro')], 'Alpha released by its own answer, Beta still held')
})
