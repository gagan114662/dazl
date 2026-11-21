// #1208: the commonest real team/agent card shape prints the person's name in a heading, their title under it, and their own
// address as a bare "Email" mailto link:
//   <div class="agent"><h3>Maya Thornton</h3><p>Real Estate Broker | Owner</p><a href="mailto:maya@...">Email</a></div>
// A single-name local part ("maya@") needs the page's own pairing, and a mailto href never pairs, so this card published nothing:
// the buyer was found (named, titled) and her own published address was dropped. The structural pairing added for it holds only
// when the heading is exactly her full name, the only text between heading and link is the title the crawl recorded for her, the
// link is a plain mailto with no query and names nobody, and no other heading is stacked on hers. Every earlier guard still runs.
// Real-data shape (NEVER-AGAIN #5): the card markup of a real Austin brokerage's team page, names and domain replaced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { crawlJob, addressContexts, type Get } from '../lib/connectors/sitecrawl.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { identityOf } from '../lib/scan/opportunity.ts'
import { findWorkEmail } from '../lib/people/work-email.ts'
import { targetKey, workEmailTargets } from '../lib/people/work-email-eligible.ts'
import { personalAddresses, publishedFor, type AddressContext } from '../lib/people/email-pattern.ts'

const SITE = 'bluebonnetrealty.com'
const PROSE = '<p>Bluebonnet Realty is a boutique real estate firm servicing the Greater Austin area. We help buyers and sellers with every step of the process, and we care about the neighborhoods we work in and the people who live there.</p>'
const html = (b: string) => `<html><body>${b}</body></html>`
const ICP = { summary: 'Austin real-estate brokerages', who: ['Broker', 'Owner'], where: ['Austin, TX'], signals: [] }
const OWNER = 'Real Estate Broker | Owner', AGENT = 'Real Estate Agent'
// the real card: heading, title line, bare "Email" mailto (plus the photo and profile link the page serves)
const card = (name: string, title: string, mail: string, o: { link?: string; head?: string } = {}) =>
  `<div class="agent-card"><a href="/agents/${name.toLowerCase().replace(/[^a-z]+/g, '-')}"><img src="/img/agent.jpg" alt=""></a>${o.head ?? `<h3 class="agent-card__name">${name}</h3>`}<p class="agent-card__title">${title}</p>${mail ? `<a class="agent-card__email" href="${mail}">${o.link ?? 'Email'}</a>` : ''}</div>`
const OWEN = card('Owen Pike', AGENT, `mailto:owen@${SITE}`)

async function run(team: string) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'proptech', location: 'Austin, TX' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(ICP), job)
  const lead = 'c'.repeat(24)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(lead, job, 'Bluebonnet Realty', null, 'Boutique Austin brokerage', `https://${SITE}/`, 'Bluebonnet Realty, a boutique real estate firm servicing the Greater Austin area', 90, 80)
  const PAGES: Record<string, string> = {
    '/robots.txt': 'User-agent: *\nAllow: /',
    '/': html(`${PROSE}<p>Bluebonnet Realty, 100 Example Ave, Austin, TX 78702</p><a href="/team">Our Team</a>`),
    '/team': html(`${PROSE}<section class="agents">${team}</section>`),
  }
  const get: Get = async url => { const p = PAGES[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 'T', job, { get, gapMs: 0, env: { SITECRAWL_ENABLED: '1' }, now: Date.parse('2026-11-13T12:00:00Z') })
  const rows = enrichmentsForLeads(db, 'T', [lead])[lead] ?? []
  const site = identityOf({ id: lead, contact: null }, rows)
  const targets = workEmailTargets(rows, ICP.who.join('; '), Date.parse('2026-11-13T12:00:00Z'), site).map(targetKey)
  const calls: string[] = []
  const r = await findWorkEmail(db, 'T', lead, `Maya Thornton|${OWNER}`, { env: {}, now: 1_794_000_000, fetchImpl: (async (u: RequestInfo | URL) => { calls.push(String(u)); throw new Error('no provider call expected') }) as typeof fetch })
  return { site, targets, r, calls }
}

test('#1208 the real card shape (heading, title, bare "Email" mailto): one click shows the buyer\'s published work email with its page', async () => {
  const { site, targets, r, calls } = await run(`${card('Maya Thornton', OWNER, `mailto:maya@${SITE}`)}${OWEN}`)
  assert.equal(site?.state, 'fact'); assert.equal(site?.site, SITE)
  assert.deepEqual(targets, [`Maya Thornton|${OWNER}`], 'precondition: the broker/owner is the one buyer target')
  assert.equal(r.status, 'published', JSON.stringify(r))
  const row = (r as { row: { address: string; source_url: string; provider: string } }).row
  assert.deepEqual([row.address, row.source_url, row.provider], [`maya@${SITE}`, `https://${SITE}/team`, 'site'])
  assert.deepEqual(calls, [], 'free: no provider was called')
})

// Every wrong-person shape the issue lists, and the neighbours of the new rule, through the same crawl and click: never published.
const MT = (o: Parameters<typeof card>[3] = {}, mail = `mailto:maya@${SITE}`, title = OWNER) => card('Maya Thornton', title, mail, o)
for (const [label, team] of [
  ['another person in the heading', MT({ head: '<h3>Maya Thornton &amp; Owen Pike</h3>' })],
  ['two headings: another person\'s heading stacked on hers', MT({ head: '<h3>Owen Pike</h3><h3>Maya Thornton</h3>' })],
  ['two headings: a different Maya right after hers', MT({ head: '<h3>Maya Thornton</h3><h3>Maya Ortiz</h3>' })],
  ['the heading names a different Maya (her own card is elsewhere, without the address)', `${card('Maya Thornton', OWNER, '')}${card('Maya Ortiz', AGENT, `mailto:maya@${SITE}`)}`],
  ['the address only in a share link', MT({}, `https://twitter.com/intent/tweet?text=maya@${SITE}`)],
  ['the mailto carries a subject', MT({}, `mailto:maya@${SITE}?subject=Hello`)],
  ['the mailto subject names someone else', MT({}, `mailto:maya@${SITE}?subject=For%20Maya%20Ortiz`)],
  ['the link text names someone else', MT({ link: 'Email Owen' })],
  ['the link text names another Maya', MT({ link: 'Email Maya Ortiz' })],
  ['the line between heading and link is not her title', `${MT({ head: '<h3>Maya Thornton</h3><p>Assistant: Ana Reyes</p>' })}`],
  ['a firm named after her in the heading', MT({ head: '<h3>Maya Thornton Realty</h3>' })],
  ['a hyphenated name containing hers', MT({ head: '<h3>Maya Thornton-Ortiz</h3>' })],
  ['the heading is her first name only', MT({ head: '<h3>Maya</h3>' })],
  // council (haiku): a link that names one person by first name, an image inside the link naming someone, and two recipients
  ['the link text is another person\'s first name', MT({ link: 'Ana' })],
  ['the link text names another person in lower case', MT({ link: 'email ana' })],
  ['an image inside the link names another person', MT({ link: '<img src="/img/o.jpg" alt="Owen Pike">' })],
  ['the link\'s title names another person', `<div class="agent-card"><h3>Maya Thornton</h3><p>${OWNER}</p><a href="mailto:maya@${SITE}" title="Email Owen Pike">Email</a></div>`],
  // council (sonnet): the heading is in one part of the page and the mailto in another
  ['the mailto is in the footer, the heading in the section above', `<section><h3>Maya Thornton</h3><p>${OWNER}</p></section><footer><a href="mailto:maya@${SITE}">Email</a></footer>`],
  ['the mailto is in the next list item', `<ul><li><h3>Maya Thornton</h3><p>${OWNER}</p></li><li><a href="mailto:maya@${SITE}">Email</a></li></ul>`],
  ['an "Email us" link', MT({ link: 'Email us' })],
  ['the mailto has a second recipient', MT({}, `mailto:maya@${SITE},owen@${SITE}`)],
  ['the mailto has a second recipient after a semicolon', MT({}, `mailto:maya@${SITE};owen@${SITE}`)],
] as const) {
  test(`#1208 wrong person stays refused: ${label}`, async () => {
    const { r } = await run(`${team}${OWEN}`)
    assert.notEqual(r.status, 'published', JSON.stringify(r))
  })
}

// The issue's literal shape and the boundary of the rule, on the same three functions the crawl uses (addresses, contexts, attribution).
const seenFrom = (h: string) => personalAddresses(h, 'x.com').map(a => ({ address: a.address, url: 'https://x.com/team', ctx: addressContexts(h, a.at) as AddressContext[] }))
const maya = { first: 'maya', last: 'thornton' }
test('#1208 the issue\'s literal shape publishes for the buyer the crawl titled; without her recorded title it stays refused', () => {
  const h = '<h3>Maya Thornton</h3><a href="mailto:maya@x.com">Email</a>'
  const pub = publishedFor(maya, seenFrom(h), [maya], 'Broker')
  assert.deepEqual(pub && [pub.address, pub.url], ['maya@x.com', 'https://x.com/team'])
  assert.equal(publishedFor(maya, seenFrom(h), [maya]), null, 'no recorded title: no heading pairing (the display-only importer path)')
  // another named person reachable by the same local part still makes it nobody's
  assert.equal(publishedFor(maya, seenFrom(h), [maya, { first: 'maya', last: 'ortiz' }], 'Broker'), null)
  // her title as the page writes it, with an entity, still matches the title the crawl recorded
  const t = publishedFor(maya, seenFrom('<h3>Maya Thornton</h3><p>Owner&#39;s Agent</p><a href="mailto:maya@x.com">Email</a>'), [maya], "Owner's Agent")
  assert.equal(t?.address, 'maya@x.com')
})

// Differential (the issue's "Done when"): every combination of heading, line between, link text, href and neighbour, judged with
// the rule (title given) and as before (no title). The rule may only ADD the one shape it is for; it never adds anything else.
test('#1208 differential: the new rule adds only the heading + own-title + plain-mailto shape, and nothing the old rule refused otherwise', () => {
  const heads = ['<h3>Maya Thornton</h3>', '<h3>Maya A. Thornton</h3>', '<h3>maya thornton</h3>', '<h2>Maya Thornton</h2>', '<h3>Maya</h3>', '<h3>Maya Ortiz</h3>', '<h3>Maya Thornton &amp; Ana Lee</h3>', '<h3>Maya Thornton Realty</h3>', '<h3>Maya Thornton-Ortiz</h3>', '<h3>Ana Lee</h3><h3>Maya Thornton</h3>', '<h3>Maya Thornton</h3><h3>Ana Lee</h3>', '<p>Maya Thornton</p>', '']
  const betweens = ['', '<p>Broker</p>', '<p>broker</p>', '<p>Agent</p>', '<p>Broker</p><p>Licensed since 2009</p>', '<p>Assistant: Ana Lee</p>', '<p>Maya Ortiz</p>', '<div><span>Broker</span></div>', '<img src="a.jpg" alt="Ana Lee">']
  const links = ['Email', 'Email me', 'maya@x.com', 'Email Ana', 'Email Maya Ortiz', '', 'Ana', 'email ana', '<img src="a.jpg" alt="Owen Pike">', '<img src="a.jpg" alt="Email">']
  const hrefs = ['mailto:maya@x.com', 'mailto:maya@x.com?subject=Hi', 'mailto:maya@x.com?subject=Maya%20Ortiz', 'https://share.example/?u=maya@x.com', 'mailto:maya@x.com,ana@x.com', 'mailto:maya@x.com;ana@x.com']
  const around = ['', '<div><h3>Maya Ortiz</h3><p>Agent</p></div>', '<div><h3>Owen Pike</h3><p>Agent</p><a href="mailto:owen@x.com">Email</a></div>']
  let cases = 0, added = 0
  const outside: string[] = []
  for (const h of heads) for (const b of betweens) for (const l of links) for (const href of hrefs) for (const a of around) {
    const page = `${a}<div class="card">${h}${b}<a href="${href}">${l}</a></div>${a}`
    const seen = seenFrom(page)
    const before = publishedFor(maya, seen, [maya]) !== null
    const after = publishedFor(maya, seen, [maya], 'Broker') !== null
    cases++
    assert.ok(!(before && !after), `the rule never removes a publication: ${page}`)
    if (after && !before) {
      added++
      const intended = ['<h3>Maya Thornton</h3>', '<h3>Maya A. Thornton</h3>', '<h3>maya thornton</h3>', '<h2>Maya Thornton</h2>'].includes(h)
        && ['', '<p>Broker</p>', '<p>broker</p>', '<div><span>Broker</span></div>'].includes(b) && ['Email', 'Email me', 'maya@x.com', '', '<img src="a.jpg" alt="Email">'].includes(l)
        && href === 'mailto:maya@x.com' && a !== around[1]
      if (!intended) outside.push(page)
    }
  }
  assert.deepEqual(outside, [], 'added publications outside the intended shape')
  assert.ok(added > 0, 'the intended shape is added')
  console.log(`#1208 differential: ${cases} cases, ${added} added (all the intended shape), 0 removed, 0 outside it`)
})
