import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crawlSite, type Get } from '../lib/connectors/sitecrawl.ts'

// Qodo #1553 (a)(b)(c): uare.ai lands on app.uare.ai/site (real chain, 2026-11-22). Its pages there obey that host's robots, a login landing
// is no company page, a person/card found there is kept under the site, and an address on a redirected page counts for the location check.
const pad = ' We build tools for professionals to sell services and courses online.'.repeat(12)
function site(o: { subRobots?: string; homePath?: string } = {}) {
  const asked: string[] = []
  const get: Get = async url => {
    asked.push(url)
    const u = new URL(url), h = u.hostname, p = u.pathname
    if (p === '/robots.txt') return { status: 200, body: h === 'app.uare.ai' ? (o.subRobots ?? 'User-agent: *\nAllow: /') : 'User-agent: *\nAllow: /', finalUrl: url }
    const land = (path: string) => `https://app.uare.ai${path}`
    if (h === 'uare.ai' || h === 'www.uare.ai' || h === 'app.uare.ai') {
      if (p === '/' || p === '/site') return { status: 200, body: `<html><body><h1>Uare.ai</h1><a href="/team">Team</a><a href="/contact">Contact</a><p>${pad}</p></body></html>`, finalUrl: land(o.homePath ?? '/site') }
      if (p === '/team') return { status: 200, body: `<html><body><h1>Our team</h1><p>We are a small team building software for creators and we care about the people who use it every single day in their work.</p><p>Dana Reyes, Co-founder</p></body></html>`, finalUrl: land('/team') }
      if (p === '/contact') return { status: 200, body: `<html><body><h1>Contact Uare.ai</h1><p>${pad}</p><address>Uare.ai, 100 Market Street, Austin, TX 78701</address></body></html>`, finalUrl: land('/contact') }
    }
    return { status: 404, body: '', finalUrl: url }
  }
  return { get, asked }
}
test('Qodo #1553 (a): pages on the subdomain obey the subdomain robots.txt', async () => {
  const s = site({ subRobots: 'User-agent: *\nDisallow: /team' })
  const r = await crawlSite('uare.ai', s.get, 0, 'Uare.ai', false, undefined, undefined, 'Founder, CEO, Head of Sales', 20_000, { ownAbout: true })
  assert.ok(s.asked.includes('https://app.uare.ai/robots.txt'), 'the landing host robots.txt was read')
  assert.ok(!s.asked.some(u => u.endsWith('/team')), 'a path the subdomain disallows is never read')
  assert.ok(!r.found.some(f => /Dana Reyes/.test(String(f.value))))
})
test('Qodo #1553 (a): a login landing is not a company page', async () => {
  const r = await crawlSite('uare.ai', site({ homePath: '/login' }).get, 0, 'Uare.ai')
  assert.equal(r.reason, 'site_unreachable')
})
test('Qodo #1553 (b)(c): the person on the landing subdomain is kept, and its redirected contact address is a location page', async () => {
  const r = await crawlSite('uare.ai', site().get, 0, 'Uare.ai', false, undefined, undefined, 'Founder, CEO, Head of Sales', 20_000, { ownAbout: true })
  assert.ok(r.found.some(f => /Dana Reyes/.test(String(f.value))), JSON.stringify(r.found.map(f => [f.kind, f.value])))
  assert.ok((r.locationPages ?? []).some(p => JSON.stringify(p).includes('Austin')), JSON.stringify(r.locationPages))
})
