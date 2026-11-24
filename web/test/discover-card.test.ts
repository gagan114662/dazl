// The line a discovery-lane lead shows on its card: confidence, and what is missing in plain words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverConfidence, discoverLine, discoverMissing, discoverSources, isDiscoverLead } from '../lib/discover/card.ts'

const full = { source_kind: 'discover', confidence: 85, event_date: '2026-10-14', date_status: 'verified', timing_note: null, name: 'Dana Ruiz', company_domain: 'northwind.example', enrichments: [] }

test('a complete lead says so; each missing piece is named', () => {
  assert.equal(isDiscoverLead(full), true)
  assert.equal(isDiscoverLead({ source_kind: 'query' }), false)
  assert.equal(discoverLine(full), 'Confidence: high. Dated signal, proof page, person and website all found.')
  assert.deepEqual(discoverMissing({ ...full, event_date: null, name: '', company_domain: null }), ['a date for the signal', 'a named person', 'the company website'])
  assert.deepEqual(discoverMissing({ ...full, name: '', enrichments: [{ kind: 'person' }] }), [], 'a person kept beside the lead counts')
  assert.deepEqual(discoverMissing({ ...full, date_status: 'unverified', timing_note: 'The page prints no date.' }), ['a date printed on the page (the date shown is when the page was published)'])
  assert.equal(discoverLine({ ...full, confidence: 45, company_domain: null }), 'Confidence: low. Missing: the company website.')
  assert.deepEqual([discoverConfidence({ confidence: 65 }), discoverConfidence({ confidence: null })], ['medium', 'low'])
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
