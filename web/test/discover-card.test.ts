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
