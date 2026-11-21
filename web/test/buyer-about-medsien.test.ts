import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { crawlSite, type Get } from '../lib/connectors/sitecrawl.ts'

// Case-1 buyer stage (#1460, run 9697d013 family): Medsien's own /company page (live, saved 2026-11-21) names
// "Hamed Ahmadi and Sina Torabi, Co-founders". The buyer read must return a named founder from the company's own page.
const fx = (f: string) => readFileSync(new URL(`./fixtures/medsien/${f}`, import.meta.url), 'utf8')
const PAGES: Record<string, string> = { '/': fx('home.html'), '/company': fx('company.html') }
const get: Get = async url => {
  const u = new URL(url)
  if (u.hostname !== 'medsien.com' && u.hostname !== 'www.medsien.com') return null
  if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
  const b = PAGES[u.pathname.replace(/\/$/, '') || '/']
  return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
}
test('Medsien (case 1): the founder named on its own /company page is found by the buyer stage', async () => {
  const r = await crawlSite('medsien.com', get, 0, 'Medsien', false, undefined, undefined, 'Founder, CEO, Head of Sales', 20_000, { ownAbout: true })
  const people = r.found.filter(f => /person|name|buyer/i.test(f.kind))
  assert.ok(people.some(p => /Hamed Ahmadi|Sina Torabi/.test(String(p.value))), 'a named co-founder from the own page')
})
test('a shared plural caption whose parts are not all person names lists no one', async () => {
  const { extractPeople } = await import('../lib/connectors/sitecrawl.ts')
  const prose = '<p>We are a small team building software for clinics and we care about the people who use it every single day in their work.</p>'
  assert.deepEqual(extractPeople(`<html><body>${prose}<p>Partners and Investors, Founders</p></body></html>`, 'https://x.example/about'), [])
  assert.deepEqual(extractPeople(`<html><body>${prose}<p>Hamed Ahmadi and Sina Torabi, Engineers</p></body></html>`, 'https://x.example/about'), [])
  assert.deepEqual(extractPeople(`<html><body>${prose}<p>Hamed Ahmadi and Sina Torabi, Co-founders</p></body></html>`, 'https://x.example/about').map(f => f.value), ['Hamed Ahmadi, Co-founder', 'Sina Torabi, Co-founder'])
})
