// The line a discovery-lane lead shows on its card: confidence, and what is missing in plain words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverConfidence, discoverLine, discoverMissing, discoverSources, isDiscoverLead } from '../lib/discover/card.ts'
import { eventDayVerified } from '../lib/scan/scoreboard.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { opportunityCard } from '../lib/scan/opportunity.ts'

// day_verified: the proof of the day as GET /api/leads sends it (lib/scan/scoreboard.ts eventDayVerified), the fact the date pill reads
const full = { source_kind: 'discover', confidence: 85, event_date: '2026-10-14', date_status: 'verified', day_verified: true, timing_note: null, name: 'Dana Ruiz', company_domain: 'northwind.example', enrichments: [] }

test('a complete lead says so; each missing piece is named', () => {
  assert.equal(isDiscoverLead(full), true)
  assert.equal(isDiscoverLead({ source_kind: 'query' }), false)
  assert.equal(discoverLine(full), 'Confidence: high. Dated signal, proof page, person and website all found.')
  assert.deepEqual(discoverMissing({ ...full, event_date: null, name: '', company_domain: null }), ['a date for the signal', 'a named person', 'the company website'])
  assert.deepEqual(discoverMissing({ ...full, name: '', enrichments: [{ kind: 'person' }] }), [], 'a person kept beside the lead counts')
  assert.deepEqual(discoverMissing({ ...full, date_status: 'unverified', day_verified: false, timing_note: 'The page prints no date.' }), ['a date printed on the page (the date shown is when the page was published)'])
  assert.equal(discoverLine({ ...full, confidence: 45, company_domain: null }), 'Confidence: low. Missing: the company website.')
  assert.deepEqual([discoverConfidence({ confidence: 65 }), discoverConfidence({ confidence: null })], ['medium', 'low'])
})

// #1238 (status map of 2026-11-24): one card said "event date ... (verified on the cited source)" and, two lines down, "Missing: the date
// confirmed on the page". The pill read the stored proof of the day; the Missing line read date_status, which a lead kept for review is
// always stored without. Both, and the opportunity card's date note, now read the one fact the list sends (day_verified).
test('#1238 the date pill, the Missing line and the opportunity card say one thing about a date, for every stored combination', () => {
  const recent = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
  // the lead as GET /api/leads sends it: the stored row, plus day_verified from the route's own function
  const sent = (o: Record<string, unknown>) => {
    const row = { id: 'a'.repeat(24), source_kind: 'discover', company: 'Northwind Dental', name: 'Dana Ruiz', signal: 'Opening a second clinic', source_url: 'https://news.example/northwind',
      evidence_excerpt: 'Northwind Dental will open its second clinic', review_reason: null, fit: 4, intent: 4, why: 'expanding', icp_match: null, company_domain: 'northwind-dental.example', contact: null,
      confidence: 85, timing_note: null, enrichments: [], event_date: null as string | null, event_date_proof: null as string | null, date_status: null as string | null, ...o }
    return { ...row, day_verified: eventDayVerified(row) } as never
  }
  // the reported card: kept for review, so stored 'unverified', with its date printed on the confirmed proof page
  const reported = sent({ event_date: recent, event_date_proof: 'page_bound', date_status: 'unverified', review_reason: 'source_review_required' })
  assert.match(leadCardSummary(reported).date, /\(verified on the cited source\)$/)
  assert.equal(discoverLine(reported), 'Confidence: high. Dated signal, proof page, person and website all found.')
  assert.deepEqual(opportunityCard(reported).missing.filter(m => /date/.test(m)), [])
  assert.equal(opportunityCard(reported).whyNow.dateNote, `${recent}, printed on the proof page`)
  // no proof of the day is stored, whatever date_status says: claimed on the pill, and named as missing
  const claimed = sent({ event_date: recent, event_date_proof: null, date_status: 'verified' })
  assert.match(leadCardSummary(claimed).date, /^claimed event date /)
  assert.match(discoverLine(claimed), /Missing: the date confirmed on the page/)
  assert.deepEqual(opportunityCard(claimed).missing.filter(m => /date/.test(m)), ['the date confirmed on the page'])
  assert.equal(opportunityCard(claimed).whyNow.dateNote, `${recent}, the day the page was published`)
  // every combination of the three stored fields: the pill says verified exactly when no line names the date as missing
  for (const event_date of [null, recent]) for (const event_date_proof of [null, 'page_bound']) for (const date_status of [null, 'verified', 'unverified', 'undated']) {
    const l = sent({ event_date, event_date_proof, date_status }), at = JSON.stringify({ event_date, event_date_proof, date_status })
    const verified = /verified on the cited source/.test(leadCardSummary(l).date), card = opportunityCard(l)
    assert.equal(verified, !!event_date && event_date_proof === 'page_bound', at)
    assert.equal(/a date for the signal|the date confirmed on the page|a date printed on the page/.test(discoverLine(l)), !verified, `Missing line: ${at}`)
    assert.equal(card.missing.some(m => /date/.test(m)), !verified, `opportunity card, missing: ${at}`)
    assert.equal(/printed on the proof page/.test(card.whyNow.dateNote), verified, `opportunity card, date note: ${at}`)
  }
})

test('each fact links to the page it came from, and only links the run stored', () => {
  const l = { source_url: 'https://news.example/a', enrichments: [
    { kind: 'person', connector: 'discover', value: 'Dana Ruiz, Owner', source_url: 'https://a.example/team' },
    { kind: 'email', connector: 'discover', value: 'dana@a.example', source_url: 'https://a.example/contact' },
    { kind: 'linkedin', connector: 'discover', value: 'https://www.linkedin.com/in/dana-ruiz/', source_url: 'https://a.example/team' },
    { kind: 'person', connector: 'sitecrawl', value: 'Someone Else', source_url: 'https://other.example' },
  ] }
  assert.deepEqual(discoverSources(l).map(x => [x.label, x.url]), [['Signal', 'https://news.example/a'], ['Person', 'https://a.example/team'], ['Email', 'https://a.example/contact'], ['LinkedIn', 'https://www.linkedin.com/in/dana-ruiz/']])
  assert.deepEqual(discoverSources({ source_url: null, enrichments: [] }), [])
})

// #1401: each link under Sources is the page for the fact the card SHOWS. The Email link was the first stored address's page, also when
// that address was a shared inbox or a colleague's (not the contact the card names), and a company's LinkedIn page was linked as the
// person's LinkedIn. A fact the card does not show has no link.
test('#1401: Sources links the page of the address and the profile the card shows, never another address or a company page', () => {
  const person = { kind: 'person', connector: 'discover', value: 'Dana Ruiz, Owner', source_url: 'https://a.example/team' }
  const own = { kind: 'email', connector: 'discover', value: 'dana.ruiz@a.example', source_url: 'https://a.example/dana' }
  const shared = { kind: 'email', connector: 'discover', value: 'info@a.example', source_url: 'https://a.example/contact' }
  const colleague = { kind: 'email', connector: 'discover', value: 'sam.lee@a.example', source_url: 'https://a.example/sam' }
  const profile = { kind: 'linkedin', connector: 'discover', value: 'https://www.linkedin.com/in/dana-ruiz/', source_url: 'https://a.example/team' }
  const companyPage = { ...profile, value: 'https://www.linkedin.com/company/a-example/' }
  const links = (enrichments: unknown[], name = 'Dana Ruiz') => discoverSources({ source_kind: 'discover', name, source_url: 'https://news.example/a', enrichments } as never).map(x => [x.label, x.url])
  const signal = ['Signal', 'https://news.example/a'], who = ['Person', 'https://a.example/team'], li = ['LinkedIn', 'https://www.linkedin.com/in/dana-ruiz/']
  // the person's own address is the one linked, wherever it stands among the stored rows
  assert.deepEqual(links([person, shared, colleague, own, profile]), [signal, who, ['Email', 'https://a.example/dana'], li])
  // only a shared inbox or a colleague's address is stored: no Email link, since the card names no address for this person
  assert.deepEqual(links([person, shared, profile]), [signal, who, li])
  assert.deepEqual(links([person, colleague]), [signal, who])
  // a company's LinkedIn page is not the person's profile
  assert.deepEqual(links([person, own, companyPage]), [signal, who, ['Email', 'https://a.example/dana']])
  // nobody named: a stored profile or address is nobody's, so only the signal is sourced
  assert.deepEqual(links([shared, profile], ''), [signal])
})
