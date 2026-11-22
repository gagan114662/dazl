import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contactPaths, extractPeople } from '../lib/connectors/sitecrawl.ts'

// Refs #1122: a live check (2026-11-22) found the buyer named on UpGuard's, OnBoard's and Simple AI's own pages, yet prod stored none.
// Real pages saved that day: the crawl must reach the page that names the buyer within its page cap, and read the person there.
const F = (n: string) => readFileSync(new URL(`./fixtures/buyer-pages/${n}`, import.meta.url), 'utf8')
const WHO = 'Founder, CEO, Head of Sales'
const firstReads = (d: string) => contactPaths(F(`${d}-home.html`), new URL(`https://${d}/`), true).slice(0, 3)

test('a product page whose slug ends in "-management" is not a people directory, and the homepage-linked about page is read early', () => {
  assert.ok(!firstReads('upguard.com').some(p => p.startsWith('/product/')), JSON.stringify(firstReads('upguard.com')))
  assert.ok(!firstReads('onboardmeetings.com').some(p => p.startsWith('/board-portal/')), JSON.stringify(firstReads('onboardmeetings.com')))
  assert.ok(firstReads('onboardmeetings.com').includes('/about-us/'), JSON.stringify(firstReads('onboardmeetings.com')))
  assert.ok(firstReads('upguard.com').includes('/about'), JSON.stringify(firstReads('upguard.com')))
  assert.ok(firstReads('usesimple.ai').includes('/team/'), JSON.stringify(firstReads('usesimple.ai')))
})
test('the named buyers on those pages are read', () => {
  const p = (d: string, f: string, path: string) => extractPeople(F(f), `https://${d}${path}`, WHO).map(x => x.value)
  assert.ok(p('upguard.com', 'upguard.com-about.html', '/about').includes('Mike Baukes, Co-Founder & CEO'))
  assert.ok(p('onboardmeetings.com', 'onboardmeetings.com-about-us.html', '/about-us/').includes('Marc Huffman, Chief Executive Officer'))
  // a screen-reader-only " on LinkedIn" between the name and the title does not hide the CEO
  assert.ok(p('usesimple.ai', 'usesimple.ai-about-us.html', '/about-us/').includes('Catheryn Li, Chief Executive Officer'))
})

test('the buyer is stored even with no route: one person is chosen from the own page, the request\'s role first, then seniority; no email is attached', async () => {
  const { chooseSiteBuyer } = await import('../lib/connectors/sitecrawl.ts')
  const people = (d: string, f: string, path: string) => extractPeople(F(f), `https://${d}${path}`, WHO)
  assert.equal(chooseSiteBuyer(people('upguard.com', 'upguard.com-about.html', '/about'), WHO)?.value, 'Mike Baukes, Co-Founder & CEO')
  assert.equal(chooseSiteBuyer(people('onboardmeetings.com', 'onboardmeetings.com-about-us.html', '/about-us/'), WHO)?.value, 'Marc Huffman, Chief Executive Officer')
  assert.equal(chooseSiteBuyer(people('usesimple.ai', 'usesimple.ai-about-us.html', '/about-us/'), WHO)?.value, 'Catheryn Li, Chief Executive Officer')
  // a page naming no one with a buyer title gives no buyer; two equally ranked people with different names are ambiguous: none
  assert.equal(chooseSiteBuyer([{ kind: 'person', value: 'Robin Fleming, Chief Technology Officer', label: 'x', url: 'https://a.com/about' }], WHO), null)
  assert.equal(chooseSiteBuyer([{ kind: 'person', value: 'Ann Lee, CEO', label: 'x', url: 'https://a.com/about' }, { kind: 'person', value: 'Bob Ray, CEO', label: 'x', url: 'https://a.com/about' }], WHO), null)
})

test('Qodo #1532: hidden or former sections are cut in every class form; comments and scripts never steer the cutter', () => {
  const prose = '<p>' + 'we build software for teams and we care about our customers deeply every single day of the year '.repeat(3) + '</p>'
  const page = (x: string) => `<html><body>${prose}<ul><li><h3>Ann Carter</h3><p>Chief Executive Officer</p></li></ul>${x}</body></html>`
  const names = (x: string) => extractPeople(page(x), 'https://acme.com/team', WHO).map(f => f.value.split(',')[0])
  const bob = '<li><h3>Bob Dunlop</h3><p>Co-Founder</p></li>'
  assert.deepEqual(names(`<div class="hidden">${bob}</div>`), ['Ann Carter'])
  assert.deepEqual(names(`<div class="d-none sm">${bob}</div>`), ['Ann Carter'])
  assert.deepEqual(names(`<div class=former-team>${bob}</div>`), ['Ann Carter'])
  // a commented-out unclosed former section does not wipe the page's current people
  assert.deepEqual(names('<!-- <div class="former-team"> -->'), ['Ann Carter'])
  // a closing tag inside a script does not end a hidden section early
  assert.deepEqual(names(`<div class="hidden"><script>var s = "</div>"</script>${bob}</div>`), ['Ann Carter'])
})

test('Qodo High #1532: nav and button text is never a person, even beside a buyer title and on a page with no lower-case "us"', async () => {
  const { chooseSiteBuyer } = await import('../lib/connectors/sitecrawl.ts')
  const prose = '<p>' + 'We Build Software For Teams And Care About Customers Every Single Day Of The Year With Great Service Today '.repeat(1) + '</p><p>' + 'our platform helps revenue teams find accounts and write better emails each week for growth '.repeat(2) + '</p>'
  for (const nav of ['Contact Us', 'Get Started', 'Book a Demo', 'Book Demo', 'Sign Up', 'Learn More', 'Request Demo', 'Talk To Sales']) {
    const html = `<html><body>${prose}<ul><li><h3>${nav}</h3><p>Chief Executive Officer</p></li></ul></body></html>`
    const found = extractPeople(html, 'https://acme.com/team', WHO)
    assert.deepEqual(found.map(f => f.value), [], nav)
    assert.equal(chooseSiteBuyer([{ kind: 'person', value: `${nav}, CEO`, label: 'x', url: 'https://acme.com/team' }], WHO), null, nav)
    const ld = `<html><body>${prose}<script type="application/ld+json">{"@type":"Organization","name":"Acme","employee":[{"@type":"Person","name":"${nav}","jobTitle":"CEO"}]}</script></body></html>`
    assert.deepEqual(extractPeople(ld, 'https://acme.com/team', WHO).map(f => f.value), [], 'json-ld ' + nav)
  }
  assert.equal(chooseSiteBuyer([{ kind: 'person', value: 'Catheryn Li, CEO', label: 'x', url: 'https://acme.com/team' }], WHO)?.value, 'Catheryn Li, CEO')
})

test('Qodo #1540: a real name holding a UI word (middle initial "A.", surname Read) is still a person; only all-UI text is refused', async () => {
  const { chooseSiteBuyer, isUiText } = await import('../lib/connectors/sitecrawl.ts')
  assert.equal(isUiText('Maya A. Thornton'), false); assert.equal(isUiText('Bill Read'), false); assert.equal(isUiText('Contact Us'), true)
  assert.equal(chooseSiteBuyer([{ kind: 'person', value: 'Maya A. Thornton, CEO', label: 'x', url: 'https://acme.com/team' }], WHO)?.value, 'Maya A. Thornton, CEO')
})
