import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople, contactPaths, seniority } from '../lib/connectors/sitecrawl.ts'

const U = 'https://acme-software.example/leadership'
const PROSE = '<p>We build software for revenue teams and we care about every customer that trusts us with their pipeline every single day.</p>'
const vals = (html: string, url = U) => extractPeople(PROSE + html, url).map(x => x.value)

test('B2B buyer titles are accepted when the whole title matches', () => {
  assert.deepEqual(vals('<h3>Dana Lee</h3><p>CTO</p><h3>Marcus Webb</h3><p>VP of Sales</p><h3>Priya Shah</h3><p>Chief Revenue Officer</p>'),
    ['Dana Lee, CTO', 'Marcus Webb, VP of Sales', 'Priya Shah, Chief Revenue Officer'])
})

test('titles with trailing free text or a different company are still rejected', () => {
  assert.deepEqual(vals('<h3>Dana Lee</h3><p>Director, Other Corp</p><h3>Marcus Webb</h3><p>Head of Sales at Rival Inc</p><h3>Sam Ortiz</h3><p>Assistant to the CTO</p>'), [])
})

test('when a page lists many people the most senior three are kept, not the first three', () => {
  const cards = [['Ann Bell', 'Practice Manager'], ['Bob Cole', 'Office Manager'], ['Cy Dunn', 'Director of Marketing'], ['Di Eng', 'Founder'], ['Ed Fox', 'CEO']]
    .map(([n, t]) => `<h3>${n}</h3><p>${t}</p>`).join('')
  const v = vals(cards)
  assert.equal(v.length, 3)
  assert.ok(v.includes('Di Eng, Founder') && v.includes('Ed Fox, CEO'))
  assert.ok(!v.includes('Ann Bell, Practice Manager'))
})

test('seniority ordering', () => {
  assert.ok(seniority('Founder') > seniority('VP of Sales'))
  assert.ok(seniority('VP of Sales') > seniority('Director'))
  assert.ok(seniority('Director') > seniority('Office Manager'))
})

test('team and leadership pages are always tried, still same-site and https only', () => {
  const p = contactPaths('<html></html>', new URL('https://acme.com/'))
  assert.ok(p.includes('/team') && p.includes('/leadership'))
})
