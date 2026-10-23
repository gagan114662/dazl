import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople, crawlSite, type Get } from '../lib/connectors/sitecrawl.ts'

const U = 'https://acme-roofing.example/about'
test('extracts a named person with a title from JSON-LD and from visible team cards, never an email', () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","employee":{"@type":"Person","name":"Dana Lee","jobTitle":"Owner"}}</script>
    <div class="card"><h3>Marcus Webb</h3><p>General Manager</p></div>
    <p>Priya N. Shah, Practice Manager</p><a href="mailto:marcus@acme-roofing.example">mail</a>`
  const p = extractPeople(html, U)
  assert.deepEqual(p.map(x => x.value), ['Dana Lee, Owner', 'Marcus Webb, General Manager', 'Priya N. Shah, Practice Manager'])
  assert.ok(p.every(x => x.kind === 'person' && x.url === U && !x.value.includes('@')))
})
test('rejects headings, slogans and non-title lines (no guessed people)', () => {
  const html = `<h2>Meet Our Team</h2><p>Owner</p><h3>Contact Us</h3><p>Director of nothing in particular here and more</p>
    <p>Call Today, Free Quote</p><h3>Roof Repair</h3><p>Owner operated since 1998</p><p>Our Owner</p>`
  assert.deepEqual(extractPeople(html, U), [])
})
test('crawlSite keeps people separate: a person-only site stays none_published and a role mailbox is never crowded out', async () => {
  const pages: Record<string, string> = {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': '<title>Acme Roofing</title><a href="/about">About</a><a href="/contact">Contact</a>',
    '/about': '<h3>Dana Lee</h3><p>Owner</p><h3>Marcus Webb</h3><p>Director</p><h3>Priya Shah</h3><p>Partner</p><h3>Omar Reyes</h3><p>President</p>',
    '/contact': '<a href="mailto:info@acme-roofing.example">info</a>',
  }
  const get: Get = async (u) => { const path = new URL(u).pathname; return path in pages ? { status: 200, body: pages[path], finalUrl: u } : { status: 404, body: '', finalUrl: u } }
  const r = await crawlSite('acme-roofing.example', get, 0, 'Acme Roofing')
  assert.equal(r.reason, 'ok')
  assert.deepEqual(r.found.filter(f => f.kind === 'email').map(f => f.value), ['info@acme-roofing.example'])
  assert.equal(r.found.filter(f => f.kind === 'person').length, 3)
  delete pages['/contact']
  const only = await crawlSite('acme-roofing.example', get, 0, 'Acme Roofing')
  assert.equal(only.reason, 'none_published')
  assert.equal(only.found.every(f => f.kind === 'person'), true)
})
test('a testimonial credit naming a third-party title is not recorded', () => {
  assert.deepEqual(extractPeople('<p>Sam Park, Director at Other Corp</p><p>Great work!</p>', U), [])
})
