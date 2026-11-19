// #1036 (Hermes 23:37: labelled addresses on scanned leads DURING the scan). The same real brokerage page shape as
// test/work-email-published-real-1036.test.ts: the crawl already records the buyer's own printed address as PUBLISHED; now the scan
// also shows it on the lead as a published contact (an email enrichment naming the person and the page), with no click and no
// provider call. Never a guess; the wrong-person guards of the published tier decide, so a neighbour's card gives nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { readContextLabel } from '../lib/outreach/contact-context.ts'

const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const card = (name: string, email: string, role: string, slug: string) => `<div class="team-member__container" data-search-string="${name} ${email}" data-tags="[]" > <a class="team-member__link" href="/agent/${slug}"> <div class="team-member__image-wrap"> <div class="team-member__image"> </div> <div class="team-member__hover"> <span class="btn btn--primary-dark team-member__btn button-style-1">LEARN MORE</span> </div> </div> <div class="team-member__info"> <span class="team-member__name">${name}</span> <span class="team-member__role">${role}</span> </div> </a> </div>`
const html = (b: string) => `<html><body>${b}</body></html>`
const page = (team: string, contactExtra = ''): Record<string, string> => ({
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': html(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Austin, TX 78702</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`),
  '/team': html(`${PROSE}<div class="team-grid__wrapper ordered-elements">${team}</div>`),
  '/contact': html(`${PROSE}<a href="mailto:hello@bluebonnetrealty.com">hello</a>${contactExtra}`),
})
const TEAM = `${card('Maya Thornton', 'maya@bluebonnetrealty.com', 'Real Estate Broker | Owner', 'maya-thornton')}${card('Owen Pike', 'owen@bluebonnetrealty.com', 'Real Estate Agent', 'owen-pike-1')}`
const ICP = { summary: 'Austin real-estate brokerages', who: ['Broker', 'Owner'], where: ['Austin, TX'], signals: [] }

async function scan(env: Record<string, string>, team = TEAM, where = ICP.where, home?: string) {
  const PAGES = page(team)
  if (home) PAGES['/'] = home
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location: where[0] })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ ...ICP, where }), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Bluebonnet Realty', null, 'Boutique Austin brokerage', 'https://bluebonnetrealty.com/', 'Bluebonnet Realty, a boutique real estate firm servicing the Greater Austin area', 90, 80)
  const calls: string[] = []
  const get: Get = async url => { calls.push(url); const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env, now: Date.parse('2026-11-13T12:00:00Z') })
  const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
  return { emails: rows.filter(r => r.kind === 'email'), calls }
}
const c3 = (n: string, e: string, r: string) => card(n, e, r, n.toLowerCase().replace(/ /g, '-'))
const OWNER = 'Real Estate Broker | Owner', AGENT = 'Real Estate Agent'

test('the buyer\'s own printed address is on the lead after the scan, labelled with the person and the page; the role inbox stays as it was', async () => {
  for (const env of [{}, { EMAIL_GUESS_ENABLED: '1' }] as Record<string, string>[]) {
    const { emails } = await scan(env)
    const maya = emails.find(e => e.value === 'maya@bluebonnetrealty.com')
    assert.ok(maya, JSON.stringify(emails))
    assert.equal(maya!.source_url, 'https://bluebonnetrealty.com/team'); assert.equal(maya!.connector, 'sitecrawl')
    assert.equal(readContextLabel(maya!.label, maya!.source_url)?.excerpt, 'Maya Thornton, Real Estate Broker | Owner: their own address, printed on the company website')
    assert.ok(emails.some(e => e.value === 'hello@bluebonnetrealty.com'), 'the published role inbox is unchanged')
    assert.equal(emails.filter(e => e.value === 'maya@bluebonnetrealty.com').length, 1, 'once')
    assert.ok(!emails.some(e => e.value === 'owen@bluebonnetrealty.com'), 'only the people the crawl kept as this lead\'s buyers')
  }
})

test('nothing for an address in another person\'s card, for a first-name address printed away from the person, or outside the US (no address kept at rest)', async () => {
  for (const team of [`${c3('Maya Thornton', '', OWNER)}${c3('Maya Ortiz', 'maya@bluebonnetrealty.com', AGENT)}`, `${c3('Maya Thornton', '', OWNER)}<p>Maya Ortiz - maya@bluebonnetrealty.com</p>`]) {
    const { emails } = await scan({}, team)
    assert.ok(!emails.some(e => e.value === 'maya@bluebonnetrealty.com'), team.slice(0, 80))
  }
  const ca = await scan({}, TEAM, ['Toronto, ON'], `<html><body>${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Toronto, ON M5V 2T6, Canada</p><a href="/team">Our Team</a><a href="/contact">Contact</a></body></html>`)
  assert.ok(!ca.emails.some(e => e.value === 'maya@bluebonnetrealty.com'), 'a non-US site keeps no personal address, so none is shown')
})

test('strict Toronto and UK crawls record a visibly co-published name/email solely in the display table', async () => {
  const { qaClaudeOnlyBudget } = await import('../lib/scan/qa-provider-policy.ts')
  const { workEmailPageRead } = await import('../lib/people/work-email.ts')
  for (const [location, address] of [
    ['Toronto, Canada', '100 Example Ave, Toronto, ON M5V 2T6, Canada'],
    ['London, UK', '100 Example Road, London NW1 6XE, UK'],
  ]) {
    const db = new Database(':memory:'); migrateAllSqlite(db)
    try {
      // Independent same-page role evidence; the obfuscated spelling itself does not establish a person.
      const employee = '<script type="application/ld+json">{"@type":"Organization","employee":{"@type":"Person","name":"Maya Thornton","jobTitle":"Owner"}}</script>'
      const team = employee + c3('Maya Thornton', '', OWNER) + '<p>Maya Thornton: maya@bluebonnetrealty.com</p>'
      const pages = page(team)
      pages['/'] = html(`<p>Bluebonnet Realty has been serving its local community and helping businesses and families for many years.</p><p>Bluebonnet Realty, ${address}</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`)
      const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location })
      db.prepare("UPDATE scan_jobs SET status='running',icp=?,run_budget=? WHERE id=?").run(JSON.stringify({ ...ICP, where: [location] }), qaClaudeOnlyBudget(null), job)
      const lead = 'c'.repeat(24)
      db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?)').run(lead, job, 'Bluebonnet Realty', 'Active broker', 'https://bluebonnetrealty.com/', 'Bluebonnet Realty, a local real estate firm', 90, 80)
      const get: Get = async url => {
        assert.equal(new URL(url).hostname, 'bluebonnetrealty.com')
        const p = pages[new URL(url).pathname]
        return { status: p === undefined ? 404 : 200, body: p ?? '', finalUrl: url }
      }
      const run = () => crawlJob(db, 'T', job, { get, gapMs: 0, env: {}, nativeOnly: true })
      const saved = () => db.prepare('SELECT address,source_url FROM published_work_email_display WHERE tenant_id=? AND lead_id=?').all('T', lead)
      const view = () => workEmailPageRead(db, 'T', [{ id: lead }]).lookups[lead]
      const verify = () => {
        assert.deepEqual(saved(), [{ address: 'maya@bluebonnetrealty.com', source_url: 'https://bluebonnetrealty.com/team' }], location)
        assert.equal(view()[0]?.address, 'maya@bluebonnetrealty.com')
      }
      await run(); verify()
      assert.equal((enrichmentsForLeads(db, 'T', [lead])[lead] ?? []).some(e => e.kind === 'email' && e.value === 'maya@bluebonnetrealty.com'), false)
      assert.deepEqual(db.prepare('SELECT address FROM email_candidates WHERE lead_id=?').all(lead), [])
      const teamPage = pages['/team'], homePage = pages['/']
      pages['/team'] = teamPage.replace('maya@bluebonnetrealty.com', '(maya@bluebonnetrealty.com)')
      await run(); verify()
      pages['/team'] = teamPage.replace('maya@bluebonnetrealty.com', '(ümaya@bluebonnetrealty.com)')
      await run(); assert.deepEqual(saved(), [], 'Paired punctuation must not permit a truncated EAI local part')
      const replaceEmail = (shown: string) => teamPage.replace('maya@bluebonnetrealty.com', shown)
      const protect = (address: string) => {
        const hex = Buffer.from([91, ...Buffer.from(address).map(byte => byte ^ 91)]).toString('hex')
        return `<span class="__cf_email__" data-cfemail="${hex}">[email protected]</span>`
      }
      const bracket = 'maya [at] bluebonnetrealty [dot] com'
      const cf = protect('maya@bluebonnetrealty.com')
      for (const shown of [bracket, cf]) {
        pages['/team'] = replaceEmail(shown)
        await run(); assert.notEqual(saved().length, 0, shown); verify()
        assert.deepEqual(db.prepare('SELECT address FROM email_candidates WHERE lead_id=?').all(lead), [])
        assert.equal((enrichmentsForLeads(db, 'T', [lead]) ?? {})[lead]?.some(e => e.kind === 'email' && e.value === 'maya@bluebonnetrealty.com') ?? false, false)
      }
      for (const shown of [`ü${bracket}`, `ü${cf}`, 'ma<!-- split -->ya [at] bluebonnetrealty [dot] com',
        'maya [at] bluebonnetrealty<script>0</script> [dot] com', `<span hidden>${cf}</span>`,
        `<template data-sample=">">${cf}</template>`, `<span style="display: none">${cf}</span>`, `<span aria-hidden="true">${bracket}</span>`, `<!-- ${cf} -->`, `<script>${cf}</script>`,
        `<span style="display&#58;none">${cf}</span>`, `<span aria-hidden="&#116;rue">${bracket}</span>`,
        `<details><summary>Contact</summary>${bracket}</details>`, `<iframe>${cf}</iframe>`,
        `<textarea>Contact ${bracket}</textarea>`,
        '<span data-email="maya [at] bluebonnetrealty [dot] com">Contact</span>',
        protect('maya@lookalike.example'), cf.replace('class="__cf_email__"', 'class="__cf_email__" title="Maya Ortiz"'),
        cf.replace('[email protected]', '<em>[email protected]</em>'),
        cf.replace('span', 'a').replace('</span>', '</a>'),
        'maya at bluebonnetrealty dot com']) {
        pages['/team'] = replaceEmail(shown)
        await run(); assert.deepEqual(saved(), [], shown)
      }
      for (const wrapped of [`<dialog>Maya Thornton: ${cf}</dialog>`, `<title>Maya Thornton: ${bracket}</title>`,
        `<p style="opacity:0">Maya Thornton: ${cf}</p>`, `<p style="color:blue">Maya Thornton: ${bracket}</p>`]) {
        pages['/team'] = teamPage.replace('<p>Maya Thornton: maya@bluebonnetrealty.com</p>', wrapped)
        await run(); assert.deepEqual(saved(), [], wrapped)
      }
      // Each fake outer close is text to the browser; it must not escape the opaque root.
      for (const raw of ['textarea', 'iframe', 'plaintext']) {
        pages['/team'] = teamPage.replace('<p>Maya Thornton: maya@bluebonnetrealty.com</p>',
          `<div><${raw}></div>Maya Thornton: ${bracket}</${raw}>`)
        await run(); assert.deepEqual(saved(), [], raw)
      }
      pages['/team'] = replaceEmail(`<span class="hidd&#101;n">${cf}</span>`)
      await run(); assert.deepEqual(saved(), [], 'entity-bearing hidden class is opaque')
      for (const shown of [bracket, cf]) {
        pages['/team'] = replaceEmail(shown).replace('Maya Thornton:', 'Maya Ortiz:')
        await run(); assert.deepEqual(saved(), [], 'a different named person cannot supply this mailbox')
      }
      for (const hidden of ['<!-- split -->', '<script>0</script>']) {
        for (const splitAddress of [`ma${hidden}ya@bluebonnetrealty.com`, `ü${hidden}maya@bluebonnetrealty.com`]) {
          pages['/team'] = teamPage.replace('maya@bluebonnetrealty.com', splitAddress)
          await run(); assert.deepEqual(saved(), [], 'Hidden markup must never join fragments or delimit a partial address')
        }
      }
      pages['/team'] = teamPage
      {
        const canada = location === 'Toronto, Canada'
        pages['/'] = html(`<p>Bluebonnet Realty has been serving its local community and helping businesses and families for many years.</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`)
        const contact = pages['/contact']
        const postal = canada ? address : '100 Example Road, London, England NW1 6XE, UK'
        const office = (heading: string, section = 'Our offices', publishedPostal = postal) => html(`<h2>${section}</h2><h3>${heading}</h3><address>${publishedPostal}</address>`)
        const matchingHeading = canada ? 'Toronto, ON' : 'London, England'
        pages['/contact'] = office(matchingHeading)
        await run(); verify()
        const mismatched = canada ? ['Toronto, TX', 'Toronto, BC', 'Toronto, Quebec'] : ['London, Scotland', 'London, Wales']
        for (const markup of [...mismatched.map(heading => office(heading)), office(matchingHeading, 'Client offices'),
          office(matchingHeading, 'Our offices', canada ? '100 Example Ave, Toronto M5V 2T6, Canada' : address)]) {
          pages['/contact'] = markup
          await run(); assert.deepEqual(saved(), [], 'Neither another jurisdiction nor a client office qualifies')
        }
        pages['/contact'] = contact
        pages['/'] = homePage
      }
      for (const prefix of ['ü', '😀', '&#252;']) {
        pages['/team'] = teamPage.replace('maya@bluebonnetrealty.com', `${prefix}maya@bluebonnetrealty.com`)
        await run(); assert.deepEqual(saved(), [], 'Never parse an address as an ASCII suffix of an internationalized local part')
        assert.deepEqual(view(), [])
      }
      pages['/team'] = teamPage
      await run(); verify()
      pages['/'] = html(`<p>Bluebonnet Realty hires remotely in ${location} and serves customers across this region.</p><a href="/team">Our Team</a><a href="/contact">Contact</a>`)
      await run(); assert.deepEqual(saved(), [], 'A service or hiring market is not the issuer’s office')
      pages['/'] = homePage
      await run(); verify()
      {
        const staff = '<script type="application/ld+json">{"@type":"Organization","employee":[{"@type":"Person","name":"Maya Thornton","jobTitle":"Owner"},{"@type":"Person","name":"Jordan Ortiz","jobTitle":"Owner"}]}</script>'
        const copies = '<p>Maya Thornton: maya@bluebonnetrealty.com</p>'.repeat(12)
        const expanded = teamPage.replace(employee, staff).replace('<p>Maya Thornton: maya@bluebonnetrealty.com</p>', copies)
        pages['/team'] = expanded
        await run(); assert.equal(saved().length, 1, 'literal-only control retained')
        pages['/team'] = expanded.replace('</body>', `<p>${'We provide updated property information for our clients. '.repeat(10)}</p><p>Jordan Ortiz: ${bracket}</p></body>`)
        await run(); assert.deepEqual(saved(), [], 'the first 12 literal contexts must never crowd out the late decoded employee')
      }
      await crawlJob(db, 'T', job, { get: async () => null, gapMs: 0, env: {}, nativeOnly: true })
      assert.deepEqual(saved(), [], 'An unsuccessful selected recrawl withdraws the former observation')
      assert.deepEqual(view(), [])
    } finally { db.close() }
  }
})
