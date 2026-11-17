// #1036 free email tier: addresses a company prints on its own site but hides from scrapers (Cloudflare Email Address Obfuscation,
// "[at]"/"[dot]" text) are read as a visitor sees them. Pure: invented company and people, no network, no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeCfEmail, revealEmails } from '../lib/people/email-reveal.ts'
import { personalAddresses } from '../lib/people/email-pattern.ts'
import { extractContacts } from '../lib/connectors/sitecrawl.ts'

// Cloudflare's own encoding: a one-byte key, then every byte of the address XOR key, as hex.
const cf = (address: string, key = 0x5a) => key.toString(16).padStart(2, '0') + [...new TextEncoder().encode(address)].map(b => (b ^ key).toString(16).padStart(2, '0')).join('')
const page = (b: string) => `<html><body>${b}</body></html>`

test('decodeCfEmail decodes Cloudflare hex and refuses anything that is not one address', () => {
  assert.equal(decodeCfEmail(cf('jane.doe@acme-roofing.com')), 'jane.doe@acme-roofing.com')
  assert.equal(decodeCfEmail(cf('Jane.Doe@Acme.com', 0x13)), 'jane.doe@acme.com')
  assert.equal(decodeCfEmail(cf('info@acme.com?subject=Quote')), 'info@acme.com')
  assert.equal(decodeCfEmail(cf('not an address')), null)
  assert.equal(decodeCfEmail('zz12'), null)
  assert.equal(decodeCfEmail(''), null)
})

test('revealEmails rewrites the Cloudflare span and href in place; a bad HEX is left untouched', () => {
  const hex = cf('jane.doe@acme.com')
  const html = page(`<p>Jane Doe, Owner</p><a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a>`)
  const out = revealEmails(html)
  assert.ok(out.includes('href="mailto:jane.doe@acme.com"'), out)
  assert.ok(out.includes('>jane.doe@acme.com</a>'), out)
  assert.ok(!out.includes('email&#160;protected'))
  const absolute = revealEmails(`<a href='https://acme.com/cdn-cgi/l/email-protection#${hex}'>mail</a>`)
  assert.equal(absolute, `<a href='mailto:jane.doe@acme.com'>mail</a>`)
  const bad = `<span class="__cf_email__" data-cfemail="5a5b5c">[email&#160;protected]</span>`
  assert.equal(revealEmails(bad), bad)
  const plain = page('<p>No addresses here, see us at acme.com</p>')
  assert.equal(revealEmails(plain), plain)
})

test('bracketed [at]/[dot] forms are read; a bare "at" sentence is not', () => {
  assert.equal(revealEmails('Write to jane.doe [at] acme [dot] com today'), 'Write to jane.doe@acme.com today')
  assert.equal(revealEmails('jane(at)acme.co.uk'), 'jane@acme.co.uk')
  assert.equal(revealEmails('j.smith {at} north-star (dot) ca'), 'j.smith@north-star.ca')
  assert.equal(revealEmails('Meet us at acme.com or at acme dot com'), 'Meet us at acme.com or at acme dot com')
})

test('the published personal tier now sees a Cloudflare-protected address on the company site', () => {
  const hex = cf('jane.doe@acme.com')
  const html = page(`<div class="team"><h3>Jane Doe</h3><p>Founder</p><a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a></div>`)
  assert.deepEqual(personalAddresses(html, 'acme.com'), [])                              // before: hidden
  const found = personalAddresses(revealEmails(html), 'acme.com')
  assert.deepEqual(found.map(f => f.address), ['jane.doe@acme.com'])                     // after: the printed address
  // another company's protected address is still refused by the same-site rule
  const other = page(`<span class="__cf_email__" data-cfemail="${cf('bob@other.org')}">[email&#160;protected]</span>`)
  assert.deepEqual(personalAddresses(revealEmails(other), 'acme.com'), [])
})

test('role inboxes hidden by Cloudflare or brackets are found by extractContacts; same-site rule unchanged', () => {
  const html = page(`<a href="/cdn-cgi/l/email-protection#${cf('info@acme.com')}"><span class="__cf_email__" data-cfemail="${cf('info@acme.com')}">[email&#160;protected]</span></a> sales [at] acme [dot] com <span data-cfemail="${cf('info@other.org')}">x</span>`)
  const emails = extractContacts(html, 'https://acme.com/contact', 'acme.com').filter(f => f.kind === 'email').map(f => f.value).sort()
  assert.deepEqual(emails, ['info@acme.com', 'sales@acme.com'])
})

// ---- Ziggy review 1288-F1: decoding must not erase the protected element's own person evidence or join separate text ----
// Pipeline as the crawl runs it: revealEmails -> personalAddresses -> addressContexts -> publishedFor, then a crawlJob persistence run.
import { addressContexts, crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { publishedFor } from '../lib/people/email-pattern.ts'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'

const MAYA = { first: 'maya', last: 'thornton' }
const SITE = 'bluebonnetrealty.com', ADDR = `maya@${SITE}`
const protectedEl = (attrs = '') => `<span class="__cf_email__" data-cfemail="${cf(ADDR)}"${attrs}>[email&#160;protected]</span>`
const owned = (html: string) => {
  const revealed = revealEmails(html)
  const seen = personalAddresses(revealed, SITE).map(a => ({ address: a.address, url: `https://${SITE}/team`, ctx: addressContexts(revealed, a.at) }))
  return publishedFor(MAYA, seen)?.address ?? null
}
const COMPETING = [['aria-label', ' aria-label="Email Maya Ortiz"'], ['title', ' title="Maya Ortiz, Agent"'], ['data-*', ' data-person="Maya Ortiz"']] as const

for (const [label, attrs] of COMPETING) {
  test(`1288-F1 pipeline: a protected first-name address whose element names another person in ${label} is nobody's, even with the buyer's name beside it`, () => {
    const html = page(`<div class="card"><h3>Maya Thornton</h3><p>Owner</p><p>Maya Thornton - ${protectedEl(attrs)}</p></div>`)
    assert.equal(owned(html), null)
    assert.ok(revealEmails(html).includes(attrs.trim()), `the element keeps its ${label}`)
  })
}
test('1288-F1 pipeline: the protected element boundary is kept, so text on either side is never joined into one pairing', () => {
  const html = page(`<p>Maya Thornton <span class="__cf_email__" data-cfemail="${cf(ADDR)}" title="staff inbox">[email&#160;protected]</span></p>`)
  assert.equal(owned(html), null)
  const out = revealEmails(html)
  assert.ok(out.includes(`title="staff inbox">${ADDR}</span>`), out)
})
test('1288-F1 pipeline control: Cloudflare\'s bare wrapper inside the buyer\'s own text ("Maya Thornton - <protected>") is still her published address', () => {
  const html = page(`<div class="card"><h3>Maya Thornton</h3><p>Owner</p><p>Maya Thornton - ${protectedEl()}</p></div>`)
  assert.equal(owned(html), ADDR)
  // ... exactly as the same page served without protection
  assert.equal(owned(page(`<div class="card"><h3>Maya Thornton</h3><p>Owner</p><p>Maya Thornton - ${ADDR}</p></div>`)), ADDR)
})

const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const crawlPages = (team: string): Record<string, string> => ({
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': page(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Austin, TX 78702</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`),
  '/team': page(`${PROSE}<div class="team-grid__wrapper ordered-elements">${team}</div>`),
  '/contact': page(`${PROSE}<a href="mailto:hello@${SITE}">hello</a>`),
})
async function crawlFind(team: string) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location: 'Austin, TX' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 'Austin brokerages', who: ['Broker', 'Owner'], where: ['Austin, TX'], signals: [] }), job)
  const lead = 'd'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Bluebonnet Realty', null, 'Boutique Austin brokerage', `https://${SITE}/`, 'Bluebonnet Realty, a boutique real estate firm servicing the Greater Austin area', 90, 80)
  const PAGES = crawlPages(team)
  const get: Get = async url => { const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-13T12:00:00Z') })
  return findWorkEmail(db, 'T', lead, 'Maya Thornton|Real Estate Broker | Owner', { env: {}, now: 1_794_000_000, fetchImpl: (async () => { throw new Error('no provider call expected') }) as unknown as typeof fetch })
}
const buyerCard = (extra: string) => `<div class="team-member__container" data-tags="[]" > <a class="team-member__link" href="/agent/maya-thornton"> <div class="team-member__info"> <span class="team-member__name">Maya Thornton</span> <span class="team-member__role">Real Estate Broker | Owner</span> </div> </a> <p>Maya Thornton - ${extra}</p> </div>`
test('1288-F1 crawlJob persistence: a protected maya@ whose element names Maya Ortiz (aria-label) is not stored as the buyer\'s published email', async () => {
  const r = await crawlFind(buyerCard(protectedEl(' aria-label="Email Maya Ortiz"')))
  assert.notEqual(r.status, 'published', JSON.stringify(r))
})
test('1288-F1 crawlJob persistence control: the same card with Cloudflare\'s bare wrapper is stored as her published email', async () => {
  const r = await crawlFind(buyerCard(protectedEl()))
  assert.equal(r.status, 'published', JSON.stringify(r))
  assert.equal((r as { row: { address: string } }).row.address, ADDR)
})
