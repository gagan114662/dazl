// Discovery + verification must not assume US / English / tech / Latin script. Stubbed replay (invented businesses, no network) across 8 countries, 6 languages and 10 categories, through the real runJob.
// "verifier-passed" is not scoreboard-qualified (no contact or fit grade here); and these numbers measure the code path, not live yield.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SCENARIOS, replay, fixtureFor } from './helpers/global-scenarios.ts'
import { runFixture } from './helpers/acceptance-harness.ts'
import { norm, companyKey, hasPhrase } from '../lib/scan/evidence.ts'

test('REPLAY: every scenario - 8 countries, 6 languages, 10 categories (3+ non-tech, 3+ countries) - is verified from its own source', async () => {
  const countries = new Set(SCENARIOS.map(s => s.country)), langs = new Set(SCENARIOS.map(s => s.lang)); assert.ok(countries.size >= 3 && langs.size >= 3)
  const nonTech = SCENARIOS.filter(s => !/SaaS/.test(s.category)); assert.ok(nonTech.length >= 3)
  for (const s of SCENARIOS) { const r = await replay(s); assert.equal(r.outcome, 'verifier-passed', `${s.id}: ${r.outcome}`) }
})
test('NEGATIVE CONTROLS in every script: a quote that is NOT on the page, or names another company, is still refused (norm keeping non-Latin letters opens no bypass)', async () => {
  for (const s of SCENARIOS) {
    const f = fixtureFor(s); const url = f.hits[0].url
    const other = { title: s.title, text: `Published. ${s.filler.repeat(20)} Unrelated text about something else entirely, nothing about the claimed event.` }
    const noQuote = await runFixture({ ...f, own: { [url]: other }, tfPages: { [url]: other } }); const l = noQuote.db.prepare('SELECT review_reason FROM leads').get() as { review_reason: string | null } | undefined
    assert.ok(!l || l.review_reason !== null, `${s.id}: a quote missing from the page must not verify (${JSON.stringify(l)})`)
    const wrongCo = await runFixture({ ...f, extraction: [{ ...f.extraction[0], company: s.lang === 'en' ? 'Zenith Holdings' : 'Zenith Holdings' }] }); const w = wrongCo.db.prepare('SELECT review_reason FROM leads').get() as { review_reason: string | null } | undefined
    assert.ok(!w || w.review_reason !== null, `${s.id}: a company not named in the quote must not verify`)
  }
})
test('norm: Latin text is unchanged apart from letters it used to erase; non-Latin scripts survive; companyKey / hasPhrase work in each', () => {
  assert.equal(norm('Café Müller  GmbH'), 'cafe muller gmbh'); assert.equal(norm('Acme, Inc.'), 'acme inc.')
  assert.equal(norm('शर्मा कोचिंग सेंटर'), 'शर्मा कोचिंग सेंटर'.normalize('NFKD').toLowerCase()); assert.notEqual(norm('दिल्ली'), ''); assert.notEqual(norm('دبي'), ''); assert.notEqual(norm('東京'), '')
  assert.equal(companyKey('Gulf Freight Services Ltd'), 'gulf freight services'); assert.notEqual(companyKey('さくら歯科クリニック'), '')
  assert.ok(hasPhrase(norm('さくら歯科クリニックは今月開業'), norm('さくら歯科クリニック')), 'unspaced script: substring match')
  assert.ok(!hasPhrase(norm('the acmefoods group'), 'acme'), 'spaced scripts still need a word boundary')
})
