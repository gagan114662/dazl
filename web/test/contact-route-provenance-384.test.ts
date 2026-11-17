// #384 (2026-11-06 finding): when the lead's direct contact is the SAME address a sitecrawl row recorded, the
// contact route must report the crawl record (its page and read date), not the lead's cited signal page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contactRoute, type RouteLead, type RouteRow } from '../lib/outreach/contact-route.ts'
import { addressCitationUrl } from '../lib/outreach/published-email.ts'

const NOW_MS = Date.UTC(2026, 10, 16)
const OLD = Date.UTC(2021, 0, 1) / 1000 // 1609459200
const crawl = (o: Partial<RouteRow> = {}): RouteRow => ({ connector: 'sitecrawl', kind: 'email', value: 'hello@company.example', label: 'contact page', source_url: 'https://company.example/contact', retrieved_at: OLD, ...o })
const domainRow = (basis: string): RouteRow => ({ connector: 'sitecrawl', kind: 'domain', value: 'company.example', label: JSON.stringify({ basis: { kind: basis, url: 'https://company.example/' } }), source_url: 'https://company.example/', retrieved_at: OLD })
const lead = (enrichments: RouteRow[]): RouteLead => ({ contact: 'hello@company.example', source_url: 'https://news.example/story', evidence_excerpt: 'Company opened a new office', enrichments })

for (const basis of ['name_probe', 'own_domain']) {
  test(`same address stored direct and by sitecrawl (${basis}): route cites the crawl page and keeps its old read date`, () => {
    const l = lead([crawl(), domainRow(basis)])
    const r = contactRoute(l, null, NOW_MS)
    assert.equal(r.provenance.url, 'https://company.example/contact')
    assert.equal(r.provenance.url, addressCitationUrl({ ...l, enrichments: l.enrichments!.map(e => ({ ...e, label: e.label ?? null })) }))
    assert.equal(r.provenance.lastReadAt, OLD)
    assert.equal(r.provenance.stale, true)
    assert.notEqual(r.provenance.state, 'cited_page')
    assert.doesNotMatch(r.provenance.text, /read when the scan ran/)
    assert.match(r.provenance.text, /last read 1 Jan 2021/)
  })
}

test('control: a direct address with no matching crawl row still cites the lead page, read when the scan ran', () => {
  const r = contactRoute(lead([crawl({ value: 'other@company.example' })]), null, NOW_MS)
  assert.equal(r.provenance.state, 'cited_page')
  assert.equal(r.provenance.url, 'https://news.example/story')
  assert.equal(r.provenance.lastReadAt, null)
  assert.match(r.provenance.text, /read when the scan ran/)
})
