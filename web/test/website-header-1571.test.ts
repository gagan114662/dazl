// #1571: the website line beside a lead's contact. The path from a stored discovery lead to the rendered header runs in
// test/helpers/leads-website-header-1571-runtime.mts (real lane, real GET /api/leads, real header component); the black-box model it
// checks is written at the top of that file. Here: the same rule on the card function directly, the controls around it, and that the
// Leads page renders the component the path test renders.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { discoverLine, discoverSite } from '../lib/discover/card.ts'

const person = { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Practice Owner', label: 'named on a public page', source_url: 'https://northwind-dental.example/team' }
const email = { connector: 'discover', kind: 'email', value: 'dana@northwind-dental.example', label: 'email verified on source page', source_url: 'https://northwind-dental.example/contact' }
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = (o: Record<string, unknown> = {}) => ({ id: 'a'.repeat(24), company: 'Northwind Dental', name: 'Dana Ruiz', signal: 'Opening a second clinic', source_url: 'https://news.example/northwind', evidence_excerpt: 'Northwind Dental will open its second clinic', event_date: recent, date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'expanding', icp_match: null, company_domain: 'northwind-dental.example', contact: null, confidence: 85, source_kind: 'discover', enrichments: [person, email], ...o })
const status = (o: Record<string, unknown> = {}) => leadCardSummary(lead(o) as never).contactStatus
const NONE = 'Unconfirmed - the company\'s own website was not identified.'

test('#1571 route seam: a stored discovery lead -> GET /api/leads -> the rendered header names its website (real lane, handler and component; no network)', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--loader', './test/helpers/tsx-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/leads-website-header-1571-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/)
})

test('#1571 the Leads page renders that header component from the card\'s own status', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(src, /import \{ ContactStatusLine \} from '\.\/contact-status'/)
  assert.match(src, /<ContactStatusLine status=\{c\.contactStatus\} \/>/)
  assert.equal(src.includes('data-testid="contact-status"'), false, 'the header is rendered in one place only')
})

test('#1571 a discovery lead\'s header: identified names the stored website and is never confirmed; absent or not a host name is not identified', () => {
  const s = status()
  assert.deepEqual(s, { confirmed: false, text: 'Website identified: northwind-dental.example. Not confirmed as the company\'s own site.' })
  assert.equal(status({ company_domain: 'WWW.Northwind-Dental.example ' })!.text, 'Website identified: northwind-dental.example. Not confirmed as the company\'s own site.', 'the same host the Website link shows')
  for (const d of [null, '', '   ', 'not a domain', 'https://', 'northwind', 'northwind-dental.example/team', 'nw@northwind-dental.example', '-bad-.example']) {
    assert.equal(status({ company_domain: d })!.text, NONE, `"${d}" is not an identified website`)
    assert.equal(discoverSite(d as string | null), null)
  }
  // Details says the same thing as the header for a value that is not a host name
  assert.match(discoverLine(lead({ company_domain: 'not a domain' }) as never), /Missing: .*the company website/)
  assert.doesNotMatch(discoverLine(lead() as never), /the company website/)
  // no contact shown, no status line at all: unchanged
  assert.equal(status({ name: '', enrichments: [] }), null)
  // a rejected lead keeps its own line
  assert.equal(status({ quarantined_at: 1 })!.text, 'Quarantined or rejected: do not contact.')
})

test('#1571 leads that are not from the discovery lane keep their header word for word, with or without a stored domain', () => {
  const old = (o: Record<string, unknown> = {}) => status({ source_kind: 'news', contact: '+1 416 555 0100', enrichments: [], name: '', ...o })
  assert.equal(old({ company_domain: null })!.text, NONE)
  assert.equal(old({ company_domain: 'northwind-dental.example' })!.text, NONE, 'the older engine\'s identity still comes only from its own site-crawl record')
  const crawl = { connector: 'sitecrawl', kind: 'domain', value: 'name-guessed.example|name_probe', label: 'domain-basis-v1:name_probe', source_url: 'https://name-guessed.example/' }
  assert.match(old({ enrichments: [crawl] })!.text, /^Unconfirmed - name match only: name-guessed\.example: found by name search, not linked from the source\./)
})

test('#1571 the website line does not move Approve: every hold is the one it was', () => {
  const why = (o: Record<string, unknown> = {}) => { const a = leadCardSummary(lead(o) as never).approve; return a.ok ? 'ok' : a.reason }
  assert.equal(why(), 'ok')
  assert.match(why({ company_domain: null }), /only on another site/, 'no stored website: the address cannot be on the company\'s own site')
  assert.match(why({ company_domain: 'not a domain' }), /only on another site/)
  // (the branch this test was written on also had holds for a refused recipient and a signal more than a year old; main has neither rule, so they are not asserted here)
  assert.match(why({ event_date: null }), /no date/)
  assert.match(why({ enrichments: [person] }), /No email address is published/)
  // owner decision 2026-11-23: an address at another domain found off the company's site is still refused; the person's own address at
  // the company's own domain now counts wherever it was found (test/discover-approve.test.ts)
  assert.match(why({ enrichments: [person, { ...email, value: 'dana@other-mail.example', source_url: 'https://directory.example/northwind' }] }), /only on another site/)
})
