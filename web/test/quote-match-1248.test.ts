import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { verifyEvidence, visibleQuote, type Candidate } from '../lib/scan/evidence.ts'

// #1248: real leads held `quote_unconfirmed` on prod (2026-11-14, prod 66449147 and the same day's scans), each with the text the verifier's own
// fetch (fetchPageDetailed) returned for its cited page, saved in test/fixtures/quote-1248/held-leads.json. Three were held only because the
// quote was compared character by character with markdown link syntax in it, or with a full stop the page writes after a space; the words are
// on the page. The others are held correctly and must stay held.
type Held = { lead: string; company: string; source_url: string; quote: string; page: { title: string; text: string } }
const held = (JSON.parse(readFileSync(new URL('./fixtures/quote-1248/held-leads.json', import.meta.url), 'utf8')) as { leads: Held[] }).leads
const byLead = (id: string) => held.find(h => h.lead === id)!
const verdict = (h: Held, quote = h.quote) => verifyEvidence({ name: '', company: h.company, contact: null, signal: 's', source_url: h.source_url, score: 80, excerpt: quote, event_date: null } as Candidate, { text: h.page.text, title: h.page.title, retrievedAt: 1 }, new Date('2026-11-14T12:00:00Z'))
const notOnPage = (h: Held) => { const v = verdict(h); return !v.ok && v.reason === 'excerpt_not_on_page' }

test('#1248 the real quotes whose words ARE on the page now match: a markdown link (mika, 10on10 Foods) and a full stop after a space (Norton Rose Fulbright)', () => {
  for (const id of ['d2298576', '6a1f2dc7', '64d0b23c']) {
    const h = byLead(id)
    assert.ok(h, id)
    assert.equal(notOnPage(h), false, `${h.company}: ${JSON.stringify(verdict(h))}`)
  }
  assert.match(byLead('d2298576').quote, /\[mika\]\(https:\/\/www\.startbase\.de\/organization\/mika-f5ff77dc\/\)/, 'the stored quote really carries the markdown link')
  assert.match(byLead('6a1f2dc7').quote, /\[Bengaluru\]\(\/tag\/bengaluru\)/)
})

test('#1248 the real quotes that are NOT on the page stay held: a sentence the page no longer says, words skipped with "...", and lines stitched from different parts of a page', () => {
  for (const id of ['3a58566b', '6c1ffc0c', '98eb2dba']) assert.equal(notOnPage(byLead(id)), true, byLead(id).company)
  // and nothing else was relaxed: one changed word, a skipped word, or a link whose visible text differs still fails
  const m = byLead('d2298576')
  assert.equal(notOnPage({ ...m, quote: m.quote.replace('sechs', 'sieben') }), true, 'one changed word')
  assert.equal(notOnPage({ ...m, quote: m.quote.replace('[mika](https://www.startbase.de/organization/mika-f5ff77dc/)', '[Moss](https://www.startbase.de/organization/mika-f5ff77dc/)') }), true, 'the link text is what is compared, not the link target')
  const n = byLead('64d0b23c')
  assert.equal(notOnPage({ ...n, quote: n.quote.replace(' real estate', '') }), true, 'a skipped word')
})

test('#1248 visibleQuote: only markdown link and bold syntax is reduced to its visible text', () => {
  assert.equal(visibleQuote('Das Berliner FinTech [mika](https://www.startbase.de/organization/mika-f5ff77dc/) hat'), 'Das Berliner FinTech mika hat')
  assert.equal(visibleQuote('unit in [Bengaluru](/tag/bengaluru), increasing'), 'unit in Bengaluru, increasing')
  assert.equal(visibleQuote('**Acme** raised __$5M__ ![logo](https://x.example/a.png)'), 'Acme raised $5M logo')
  for (const s of ['a [bracket] note', 'f(x) = [1, 2]', 'snake_case and 2*3*4', 'a ** b']) assert.equal(visibleQuote(s), s, s)
})
