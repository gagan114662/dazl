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
