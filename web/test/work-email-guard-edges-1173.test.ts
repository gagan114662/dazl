// #1173 (follow-up to #1152, Refs #1036): the remaining wrong-person edges of the published-address guard. Rows are the probes from
// the review of #1152 at c88240eb (~/work/verify/1036/rv1152/adv-c88240eb.test.ts). Buyer in every row: Maya Thornton. The same
// three functions the crawl uses; "publishes" = publishedFor returns the address for her.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressContexts } from '../lib/connectors/sitecrawl.ts'
import { personalAddresses, publishedFor, type AddressContext } from '../lib/people/email-pattern.ts'

const seenFrom = (...pagesHtml: string[]) => {
  const seen = new Map<string, { address: string; url: string; ctx: AddressContext[] }>()
  pagesHtml.forEach((h, n) => { for (const a of personalAddresses(h, 'x.com')) { const had = seen.get(a.address); const c = addressContexts(h, a.at); if (had) had.ctx.push(...c); else seen.set(a.address, { address: a.address, url: `https://x.com/p${n}`, ctx: c }) } })
  return [...seen.values()]
}
const B = { first: 'maya', last: 'thornton' }
const pub = (...h: string[]) => publishedFor(B, seenFrom(...h))?.address ?? null

test('#1173 row 1: a long attribute that names another Maya after character 400 is read whole, never cut', () => {
  assert.equal(pub(`<div data-team="Maya Thornton, Owner; ${'agent bio '.repeat(26)} email: maya@x.com ${'photo-url-segment '.repeat(8)} name: Maya Ortiz"></div>`), null)
})
test('#1173 row 2: a newline or tab between two people is never read as one name', () => {
  assert.equal(pub('<pre>Ana Maya\tThornton Lee\tmaya@x.com</pre>'), null)
  assert.equal(pub('<div data-s="Ana Maya\nThornton Lee maya@x.com"></div>'), null)
})
test('#1173 row 3: a hyphenated name that contains the buyer\'s name is someone else', () => {
  assert.equal(pub('<div data-s="Maya Thornton-Ortiz maya@x.com"></div>'), null)
  assert.equal(pub('<div data-s="Anna-Maya Thornton maya@x.com"></div>'), null)
})
test('#1173 row 4: places past the sixth on a page, and on a second page, still get a vote (12 per page)', () => {
  const m = '<a href="mailto:maya@x.com">m</a>'
  assert.equal(pub(`${m.repeat(5)}<div data-s="Maya Thornton maya@x.com"></div><div data-s="Maya Ortiz maya@x.com"></div>`), null)
  assert.equal(pub(`<div data-s="Maya Thornton maya@x.com"></div>${m.repeat(5)}<div data-s="Maya Ortiz maya@x.com"></div>`), null)
  assert.equal(pub('<div data-s="Maya Thornton maya@x.com"></div>', `${m.repeat(6)}<div data-s="Maya Ortiz maya@x.com"></div>`), null)
  // far enough apart that only the place itself can tell (the text around the earlier places does not reach the other card)
  const far = `<p>${'x '.repeat(300)}</p>`
  assert.equal(pub(`<div data-s="Maya Thornton maya@x.com"></div>${far}${m.repeat(6)}${far}<div data-s="Maya Ortiz maya@x.com"></div>`), null, 'the 8th place on the page')
})
test('#1173 row 5: another person named only in an attribute beside the address is seen; a mailto subject line is not a pairing', () => {
  assert.equal(pub('<div><img alt="Maya Ortiz"><span>maya@x.com</span></div><div data-s="Maya Thornton maya@x.com"></div>'), null)
  assert.equal(pub('<div data-s="Maya Thornton maya@x.com"></div><div><img alt="Maya Ortiz" src="a.jpg"><a href="mailto:maya@x.com">Email</a></div>'), null)
  assert.equal(pub(`<h3>Maya Ortiz</h3><a href="mailto:maya@x.com?subject=Question for Maya Thornton's team">Email</a>`), null)
})
test('#1173 row 6: firm words "Mortgage" / "Financial" after the name are not her surname\'s end', () => {
  assert.equal(pub('<p>Ask Maya Thornton Mortgage staff: maya@x.com</p>'), null)
  assert.equal(pub('<p>Maya Thornton Financial: maya@x.com</p>'), null)
})
test('#1173 the legitimate rows still publish: her own card, text pairing with a title, a middle initial; a full-name address was never under this rule', () => {
  assert.equal(pub('<div data-s="Maya Thornton maya@x.com"></div><div data-s="Maya Ortiz"></div>'), 'maya@x.com')
  assert.equal(pub('<p>Maya Thornton, Broker/Owner: maya@x.com</p>'), 'maya@x.com')
  assert.equal(pub('<div data-s="Maya O. Thornton maya@x.com"></div>'), 'maya@x.com')
  assert.equal(publishedFor(B, seenFrom('<h3>Maya Ortiz</h3><a href="mailto:maya.thornton@x.com">mail</a>'))?.address, 'maya.thornton@x.com')
})
