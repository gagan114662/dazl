import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  demandRubric, rubricForPlay, qualifyDemand, precisionReport, needTermsFromOffer,
  type DemandClass, type DemandPost, type DemandRubric, type Labelled,
} from '../lib/scan/demand-qualifier.ts'

// #401: an offer-specific demand rubric. Labelled SYNTHETIC posts, one class each; nothing is fetched and no model runs.
interface Fixture { id: string; offer: string; label: DemandClass; high_intent: boolean; comparison?: boolean; post: DemandPost }
const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/demand-qualifier/fixtures.synthetic.json', import.meta.url)), 'utf8')) as
  { as_of: string; offers: Record<string, { offer: string; own_names: string[]; competitors: string[] }>; posts: Fixture[] }
const AS_OF = new Date(FIX.as_of)
const rubrics: Record<string, DemandRubric> = Object.fromEntries(Object.entries(FIX.offers).map(([k, o]) => {
  const r = demandRubric({ offer: o.offer, competitors: o.competitors, own_names: o.own_names })
  assert.ok(r, k)
  return [k, r]
}))
const rows: (Labelled & { f: Fixture })[] = FIX.posts.map(f => ({ id: f.id, label: f.label, high_intent: f.high_intent, f, result: qualifyDemand(f.post, rubrics[f.offer], AS_OF) }))

test('fixtures cover every class the issue names, for two different offers', () => {
  const labels = new Set(rows.map(r => r.label))
  for (const c of ['buyer', 'competitor', 'vendor_promotion', 'job_seeker', 'recruiter', 'consumer', 'third_party_demand', 'unrelated_event', 'generic_growth'] as DemandClass[]) assert.ok(labels.has(c), c)
  assert.deepEqual(new Set(rows.map(r => r.f.offer)), new Set(['leadgen', 'bookkeeping']))
  assert.ok(rows.length >= 30)
})

test('every fixture gets its labelled class and tier (per-row, so a regression names the post)', () => {
  for (const r of rows) {
    assert.equal(r.result.class, r.label, `${r.id}: ${JSON.stringify(r.result.reasons)}`)
    assert.equal(r.result.tier === 'high_intent', r.high_intent, `${r.id}: tier ${r.result.tier}, missing ${r.result.missing.join(',')}`)
  }
})

test('precision: no student, recruiter, vendor, competitor, consumer, third party, event or growth post reaches high intent', (t) => {
  const rep = precisionReport(rows)
  t.diagnostic(JSON.stringify(rep))
  assert.equal(rep.high_intent.precision, 1)
  assert.equal(rep.high_intent.correct, rep.high_intent.expected) // and every high-intent buyer is found
  for (const [c, m] of Object.entries(rep.per_class)) assert.equal(m.precision, 1, `class ${c} precision`)
  assert.deepEqual(rep.confusions, [])
  for (const r of rows) if (r.label !== 'buyer') assert.notEqual(r.result.tier, 'high_intent', r.id)
})

test('evidence, fit and intent are scored separately, with source, date and the current requester', () => {
  const byId = Object.fromEntries(rows.map(r => [r.id, r.result]))
  const founder = byId['buyer-founder-b2b-leads']
  assert.deepEqual(founder.scores, { evidence: 3, fit: 3, intent: 3 })
  assert.equal(founder.source.url, 'https://forum.example.test/t/101')
  assert.equal(founder.source.published_at, '2026-10-28T09:00:00Z')
  assert.equal(founder.source.age_days, 6)
  assert.equal(founder.requester.name, 'Maya Chen')
  assert.equal(founder.requester.authority, 'decision_maker')
  // the same need without a date, without a requester, or outside the window: evidence drops, intent does not
  assert.equal(byId['buyer-no-date'].scores.intent, 3); assert.equal(byId['buyer-no-date'].scores.evidence, 2); assert.ok(byId['buyer-no-date'].missing.includes('date_unknown'))
  assert.ok(byId['buyer-anonymous'].missing.includes('requester_unknown'))
  assert.ok(byId['buyer-stale-post'].missing.includes('date_outside_window'))
  // an SDR's real need stays reviewable but has no authority to make it high intent
  assert.equal(byId['buyer-sdr-no-authority'].requester.authority, 'influencer')
  assert.ok(byId['buyer-sdr-no-authority'].missing.includes('authority_insufficient'))
  assert.equal(byId['buyer-sdr-no-authority'].tier, 'needs_evidence')
})

test('the requester is the author, never a customer the post mentions', () => {
  const tp = rows.find(r => r.id === 'third-party-client-needs-leads')!.result
  assert.equal(tp.requester.name, 'Hana Sato')
  assert.equal(tp.requester.company, 'Brightwave PR')
  assert.ok(tp.mentioned_orgs.includes('Vantage Freight'))
  assert.notEqual(tp.requester.company, 'Vantage Freight')
  // an agency buying for its own client campaigns stays eligible (agencies are not globally excluded)
  const agency = rows.find(r => r.id === 'buyer-agency-for-own-campaigns')!.result
  assert.equal(agency.class, 'buyer'); assert.equal(agency.tier, 'high_intent')
})

test('a comparison request is not permission to contact; no result ever grants contact', () => {
  const cmp = rows.find(r => r.id === 'buyer-evaluation-switching')!.result
  assert.ok(cmp.families.includes('evaluation_switching'))
  assert.equal(cmp.contact.permitted, false)
  assert.match(cmp.contact.note, /comparison/i)
  assert.ok(cmp.mentioned_orgs.includes('LeadForge')) // the competitor named is a mention, not the requester
  for (const r of rows) assert.equal(r.result.contact.permitted, false, r.id)
})

test('every reason is a verbatim quote of the post (or of the author fields for an identity rule)', () => {
  for (const r of rows) {
    assert.ok(r.result.reasons.length > 0, `${r.id} has no cited reason`)
    const hay = `${r.f.post.title ? `${r.f.post.title}\n` : ''}${r.f.post.text}`
    const who = `${r.f.post.author?.company ?? ''} ${r.f.post.author?.headline ?? ''}`
    for (const q of r.result.reasons) assert.ok(hay.includes(q.quote) || who.includes(q.quote), `${r.id}/${q.rule}: ${q.quote}`)
  }
})

test('weak triggers stay weak: funding and hiring a sales rep never count as demand on their own', () => {
  for (const id of ['event-series-a', 'recruiter-hiring-sdr', 'recruiter-founder-needs-sdr']) {
    const r = rows.find(x => x.id === id)!.result
    assert.equal(r.tier, 'weak_trigger', id); assert.ok(r.scores.intent <= 1, id); assert.deepEqual(r.families, [], id)
  }
  // ...but a funded founder who also states the need qualifies on the need, not on the round
  const funded = rows.find(r => r.id === 'buyer-funded-and-asking')!.result
  assert.equal(funded.tier, 'high_intent'); assert.ok(funded.families.includes('vendor_request'))
})

test('the rubric is the play offer, not a hardcoded seller: the same post flips with the offer', () => {
  const post = FIX.posts.find(p => p.id === 'buyer-founder-b2b-leads')!.post
  assert.equal(qualifyDemand(post, rubrics.leadgen, AS_OF).class, 'buyer')
  assert.notEqual(qualifyDemand(post, rubrics.bookkeeping, AS_OF).class, 'buyer')
  // seller names never become need terms; generic context words never do either
  assert.ok(!rubrics.leadgen.need_terms.some(t => /dazl/.test(t)))
  for (const g of ['sales', 'b2b', 'team']) assert.ok(!needTermsFromOffer('B2B sales team tools').includes(g), g)
  const src = readFileSync(fileURLToPath(new URL('../lib/scan/demand-qualifier.ts', import.meta.url)), 'utf8')
  assert.ok(!/dazl/i.test(src), 'no seller-specific branch in the qualifier')
})

test('fail closed: no offer or a conflicted play has no rubric, and every post is unqualifiable', () => {
  assert.equal(demandRubric({ offer: '' }), null)
  assert.equal(demandRubric({ offer: 'the best new tools' }), null) // nothing but generic words
  assert.deepEqual(rubricForPlay(null, []), { rubric: null, reason: 'no_such_play' })
  assert.equal(rubricForPlay({ offer: null, source: 'conflict', conflict: { stated: 'x', recorded: 'y' } }, []).reason, 'offer_conflict')
  assert.equal(rubricForPlay({ offer: null, source: 'none', conflict: null }, []).reason, 'no_offer')
  const ok = rubricForPlay({ offer: 'verified prospect lists', source: 'play', conflict: null }, ['LeadForge'])
  assert.ok(ok.rubric); assert.deepEqual(ok.rubric.competitors, ['LeadForge'])
  const r = qualifyDemand(FIX.posts[0].post, null, AS_OF)
  assert.equal(r.tier, 'unqualifiable'); assert.ok(r.missing.includes('no_offer_rubric'))
  // a future date or a non-http source is never high intent
  const fut = qualifyDemand({ ...FIX.posts[0].post, published_at: '2026-12-01T00:00:00Z' }, rubrics.leadgen, AS_OF)
  assert.equal(fut.tier, 'needs_evidence'); assert.ok(fut.missing.includes('date_in_future'))
  const bad = qualifyDemand({ ...FIX.posts[0].post, source_url: 'javascript:alert(1)' }, rubrics.leadgen, AS_OF)
  assert.equal(bad.tier, 'needs_evidence'); assert.ok(bad.missing.includes('source_url_not_http'))
})

test('deterministic: the same inputs give byte-identical results', () => {
  const again = FIX.posts.map(f => qualifyDemand(f.post, rubrics[f.offer], AS_OF))
  assert.equal(JSON.stringify(again), JSON.stringify(rows.map(r => r.result)))
})
