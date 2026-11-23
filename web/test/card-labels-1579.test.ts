// #1579 (Quest on staging 96111ddd, 2026-11-23): one lead's card contradicted itself in four places. The website header is covered by
// test/website-header-1571.test.ts. Here: the other three, on a lead shaped like the one Quest saw (row 1 of that check): found by the
// new engine, a named person with their own LinkedIn profile, no email, a website, and a signal with no date.
//   - the row said "source (verified current)" while Details said "None verified as current";
//   - Details said "Next: Message <name> on LinkedIn" on a lead with no "Message on LinkedIn" button;
//   - Details said "No published contact stored" for a lead whose named person's LinkedIn profile is stored.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { opportunityCard } from '../lib/scan/opportunity.ts'
import { discoverContactNote, discoverProofHold } from '../lib/discover/card.ts'
import { leadPerson, personBasis } from '../lib/people/lead-person.ts'
import { contactsFromEnrichments, peopleSourceText } from '../lib/people/rank.ts'
import { splitByCurrency } from '../lib/people/currency.ts'
import { contactSearchNote } from '../lib/outreach/published-email.ts'

const PROFILE = 'https://www.linkedin.com/in/dana-ruiz/'
const person = { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Co-founder', label: 'named on a public page', source_url: 'https://news.example/northwind-raises' }
const linkedin = { connector: 'discover', kind: 'linkedin', value: PROFILE, label: 'linked from a public page', source_url: 'https://news.example/northwind-raises' }
const email = { connector: 'discover', kind: 'email', value: 'dana@northwind.example', label: 'published on a public page', source_url: 'https://northwind.example/contact' }
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
// the lead as Quest saw it: no date on the signal
const lead = (o: Record<string, unknown> = {}) => ({ id: 'b'.repeat(24), company: 'Northwind', name: 'Dana Ruiz', signal: 'Hiring a founding SDR', source_url: 'https://jobs.example/northwind/sdr', evidence_excerpt: 'Northwind is hiring a founding SDR.',
  event_date: null, date_status: null, review_reason: null, fit: 4, intent: 3, why: 'Hiring a first sales role.', icp_match: null, company_domain: 'northwind.example', contact: null, confidence: 70, source_kind: 'discover', enrichments: [person, linkedin], ...o })
const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('#1579 the row and Details say the same thing about a person the new engine found: named on a public page, not verified as current', () => {
  const p = leadPerson(lead().enrichments, '')!
  assert.equal(p.name, 'Dana Ruiz')
  // nothing checked that this person holds the role today, so the row does not say it did
  assert.equal(p.current, false)
  assert.equal(personBasis(p), 'named on a public page, not verified as current')
  // Details lists the same person under "Search result only" and says "None verified as current": the two now agree
  const people = contactsFromEnrichments(lead().enrichments as never, '')
  const { verified, searchOnly } = splitByCurrency(people)
  assert.deepEqual([verified.length, searchOnly.map(x => x.name)], [0, ['Dana Ruiz']])
  // and Details names where the person came from in plain words, not the engine's internal name
  assert.equal(peopleSourceText(searchOnly[0]), 'a public page that names them (not verified as current)')
  // control: a person the company's own confirmed website lists, read recently, keeps "verified current"
  const site = { text: 'acme.example', state: 'fact' as const, site: 'acme.example' }
  const own = [{ connector: 'sitecrawl', kind: 'domain', value: 'acme.example|own_domain', label: 'domain-basis-v1:own_domain', source_url: 'https://acme.example/' },
    { connector: 'sitecrawl', kind: 'person', value: 'Jane Doe, Head of Sales', label: 'listed with this title on this company page, not verified as current staff | profile: https://www.linkedin.com/in/jane-doe', source_url: 'https://acme.example/team', retrieved_at: Math.floor(Date.now() / 1000) }]
  const jane = leadPerson(own, 'Head of Sales', Date.now(), site)
  if (jane) { assert.equal(jane.current, true); assert.equal(personBasis(jane), 'verified current') }
  assert.equal(personBasis({ name: 'A B', title: 'T', linkedin: null, source: null, via: 'the company website (listed with this title)', current: true }), 'verified current')
  // both places that print the row use the one rule
  for (const f of ['../app/app/leads/leads-client.tsx', '../app/app/first-run.tsx']) {
    assert.ok(src(f).includes('{personBasis(p)}'), `${f} prints the shared basis`)
    assert.equal(src(f).includes("p.current ? 'verified current'"), false, `${f} no longer decides the words itself`)
  }
})

test('#1579 the next step in Details follows the same rule as the "Message on LinkedIn" button', () => {
  // no date on the signal: no button, and the next step is the reason it is held, not "Message ... on LinkedIn"
  const undated = lead()
  assert.equal(leadCardSummary(undated as never).linkedin, null)
  assert.equal(opportunityCard(undated as never).next, 'The signal has no date, so its timing is unknown. Open the proof to check it.')
  assert.equal(opportunityCard(undated as never).next, discoverProofHold(undated))
  // a required check that has not passed, and a lead graded not a fit: the same
  for (const o of [{ event_date: recent, gate_held: true }, { event_date: recent, fit: 0, intent: null }]) {
    const l = lead(o)
    assert.equal(leadCardSummary(l as never).linkedin, null)
    assert.equal(opportunityCard(l as never).next, discoverProofHold(l))
    assert.doesNotMatch(opportunityCard(l as never).next, /LinkedIn/)
  }
  // dated: the button is there, and only then does the next step say to message them on LinkedIn
  const dated = lead({ event_date: recent })
  assert.deepEqual(leadCardSummary(dated as never).linkedin, { name: 'Dana Ruiz', profile: PROFILE })
  assert.match(opportunityCard(dated as never).next, /^Message Dana Ruiz on LinkedIn yourself/)
  // the stored link is a company page, not a person's profile: no button, so no "Message ... on LinkedIn"
  const companyPage = lead({ event_date: recent, enrichments: [person, { ...linkedin, value: 'https://www.linkedin.com/company/northwind/' }] })
  assert.equal(leadCardSummary(companyPage as never).linkedin, null)
  assert.equal(opportunityCard(companyPage as never).next, 'Find a way to reach Dana Ruiz.')
  // every case: "Message ... on LinkedIn" is the next step exactly when the button is shown
  for (const l of [undated, dated, companyPage, lead({ event_date: recent, enrichments: [person] }), lead({ event_date: recent, review_reason: 'unconfirmed' }), lead({ event_date: recent, quarantined_at: 1 })])
    assert.equal(/on LinkedIn/.test(opportunityCard(l as never).next), leadCardSummary(l as never).linkedin !== null)
  // unchanged: a lead that can be approved by email still says to draft a message
  assert.match(opportunityCard(lead({ event_date: recent, enrichments: [person, linkedin, email] }) as never).next, /^Draft a first message to Dana Ruiz/)
})

test('#1579 Details does not say "No published contact stored" when the named person\'s LinkedIn profile is stored', () => {
  const SAYS = 'Dana Ruiz\'s LinkedIn profile is known. No personal work email is published for them.'
  assert.equal(contactSearchNote(lead() as never), SAYS)
  assert.equal(discoverContactNote(lead()), SAYS)
  // it is about the contact, not the proof: the same with or without a date
  assert.equal(contactSearchNote(lead({ event_date: recent }) as never), SAYS)
  // no profile, or only a company page: the old sentence stays
  assert.match(contactSearchNote(lead({ enrichments: [person] }) as never) ?? '', /^No published contact stored\./)
  assert.match(contactSearchNote(lead({ enrichments: [person, { ...linkedin, value: 'https://www.linkedin.com/company/northwind/' }] }) as never) ?? '', /^No published contact stored\./)
  // a profile with nobody named is nobody's profile
  assert.equal(discoverContactNote(lead({ name: '', enrichments: [linkedin] })), null)
  // their own published address: no note at all, as before
  assert.equal(contactSearchNote(lead({ enrichments: [person, linkedin, email] }) as never), null)
  // a lead that is not from the new engine is untouched, even with the same rows beside it
  assert.match(contactSearchNote(lead({ source_kind: 'news', enrichments: [{ ...person, connector: 'search:people' }] }) as never) ?? '', /^No published contact stored\./)
  assert.equal(discoverContactNote(lead({ source_kind: 'news' })), null)
})
