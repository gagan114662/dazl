import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople, crawlSite, type Get } from '../lib/connectors/sitecrawl.ts'

const U = 'https://acme-roofing.example/about'
const PROSE = '<p>We have served the community for many years and we care about every family that walks through our doors every single day.</p>'
const vals = (html: string, url = U) => extractPeople(PROSE + html, url).map(x => x.value)

test('extracts a listed person with a full leadership title from JSON-LD employee/founder and from team cards', () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","employee":{"@type":"Person","name":"Dana Lee","jobTitle":"Owner"}}</script>
    <div class="card"><h3>Marcus Webb</h3><p>General Manager</p></div>
    <p>Priya N. Shah, Practice Manager</p><a href="mailto:marcus@acme-roofing.example">mail</a>`
  const p = extractPeople(PROSE + html, U)
  assert.deepEqual(p.map(x => x.value), ['Dana Lee, Owner', 'Marcus Webb, General Manager', 'Priya N. Shah, Practice Manager'])
  assert.ok(p.every(x => x.kind === 'person' && x.url === U && !x.value.includes('@')))
})
test('a page with no prose gives nothing to judge a name against, so nothing is extracted', () => {
  assert.deepEqual(extractPeople('<h2>Meet Our Team</h2><p>Owner</p><h3>Contact Us</h3><p>Director</p>', U), [])
  assert.deepEqual(extractPeople('<h3>Dana Lee</h3><p>Owner</p>', U), [])
})
test('title must be the whole title: trailing organisation or free text is rejected (comma and dash forms)', () => {
  assert.deepEqual(vals('<p>Sam Park, Director, Other Corp</p>'), [])
  assert.deepEqual(vals('<p>Sam Park - Director at Other Corp</p>'), [])
  assert.deepEqual(vals('<p>Sam Park, Director of Sales for Other Corp</p>'), [])
  assert.deepEqual(vals('<h3>Sam Park</h3><p>Owner of Other Corp</p>'), [])
})
test('trade and service words that look like names are rejected by page evidence, not a word list', () => {
  const page = '<p>We do roof repair and roof replacement. Our crew will repair your roof fast.</p>'
  assert.deepEqual(vals(`${page}<h3>Roof Repair</h3><p>Owner</p>`), [])
  assert.deepEqual(vals(`${page}<h3>Storm Damage</h3><p>Director</p><p>We fix storm damage, damage from hail.</p>`), [])
  assert.deepEqual(vals('<nav><a href="/services">Roof Repair</a></nav><h3>Roof Repair</h3><p>Owner</p>'), [], 'a name that is also a link label is a service')
  assert.deepEqual(vals('<h2>Meet Our Team</h2><p>Owner</p><h3>Contact Us</h3><p>Director</p>'), [])
})
test('quoted third-party content is cut before extraction: blockquote, testimonial/review blocks, JSON-LD review author', () => {
  assert.deepEqual(vals('<blockquote><p>Sam Park</p><p>Director</p></blockquote>'), [])
  assert.deepEqual(vals('<div class="testimonials"><div class="t"><h4>Ann Cole</h4><p>Owner</p></div><div><h4>Raj Rao</h4><p>Partner</p></div></div><p>Footer text.</p>'), [])
  assert.deepEqual(vals('<script type="application/ld+json">{"@type":"Review","author":{"@type":"Person","name":"Kim Ng","jobTitle":"Owner"}}</script>'), [])
  assert.deepEqual(vals('<script type="application/ld+json">{"@type":"Person","name":"Kim Ng","jobTitle":"Owner"}</script>'), [], 'a bare Person with no employee/founder/member parent is not asserted as staff')
})
test('people are read only from about/team/leadership/contact style pages, never from home or blog pages', () => {
  const card = '<h3>Dana Lee</h3><p>Owner</p>'
  assert.deepEqual(vals(card, 'https://acme-roofing.example/'), [])
  assert.deepEqual(vals(card, 'https://acme-roofing.example/blog/post-1'), [])
  assert.deepEqual(vals(card, 'https://acme-roofing.example/our-team'), ['Dana Lee, Owner'])
})
test('crawlSite keeps people separate: a person-only site stays none_published and a role mailbox is never crowded out', async () => {
  const pages: Record<string, string> = {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': '<title>Acme Roofing</title><a href="/about">About</a><a href="/contact">Contact</a>',
    '/about': PROSE + '<h3>Dana Lee</h3><p>Owner</p><h3>Marcus Webb</h3><p>Director</p><h3>Priya Shah</h3><p>Partner</p><h3>Omar Reyes</h3><p>President</p>',
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
