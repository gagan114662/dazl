// #1037: a lead is READY only when it names its buyer: a real person listed on the company's OWN website, with a title and a LinkedIn
// profile that the company's own page links. Everything on the path is the real code: the real site crawl (crawlJob, pages served through a
// stubbed fetch) writes the buyer, and the real /api/leads and /api/home/ready handlers judge the lead on the real store.
// The lead itself is stored as a finished scan stores it (its dated, structurally proven posting day, the user's "I checked the source", and the
// sales-hiring check's recorded pass), so the buyer is the only thing each case varies. Companies, people and sites are INVENTED (.example).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { createJob } from '../../lib/scan/store.ts'
import { crawlJob, type Get } from '../../lib/connectors/sitecrawl.ts'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { heldReason, previewSplit, type PreviewLead } from '../../lib/journey.ts'
import { leadPerson, NO_BUYER } from '../../lib/people/lead-person.ts'
import { identityOf } from '../../lib/scan/opportunity.ts'
import { LABEL as PROFILE_SEARCH_LABEL } from '../../lib/people/people-search.ts'
import { tiedLabel } from '../../lib/people/company-tie.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { GET as readyGET } from '../../app/api/home/ready/route.ts'

const company = 'Brindle Ledger', host = 'brindleledger.example', origin = 'https://' + host, where = 'Austin, TX'
const prose = '<p>Brindle Ledger has served its local community for many years. We help businesses find the right products and manage the process from start to finish with clear service and transparent information.</p>'
const wrap = (s: string) => '<html><body>' + s + '</body></html>'
const profile = 'https://www.linkedin.com/in/dana-reyes-example'
const NO_OWN_BUYER = 'no buyer named on the company\'s own site'
type Bio = 'linked' | 'no_link' | 'none'

async function judged(bio: Bio, extra: (db: Database.Database, lead: string) => void = () => {}) {
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'software', location: where })
  db.prepare("UPDATE scan_jobs SET status='running', query=?, icp=? WHERE id=?").run('Software companies in Austin, TX hiring an account executive', JSON.stringify({ who: ['Head of Sales'], where: [where] }), job)
  const lead = 'c'.repeat(24), posting = origin + '/careers/account-executive', now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,fit,event_date,event_date_proof,human_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(lead, job, company, null, `${company} is hiring an Account Executive in ${where}`, posting, `${company} is hiring an Account Executive to grow our customer base in ${where}`, 90, 80, 4, day, 'ats_structured', now)
  for (const pass of ['sales_hiring', 'requested_role_v1']) addEnrichment(db, 'A', lead, { connector: 'scan:gate', kind: 'gate_passed', value: pass, label: 'gate', confidence: null, source_url: posting, source_date: day, retrieved_at: now })
  const card = bio === 'none' ? '' : '<article>' + prose + '<h1>Dana Reyes</h1><p>Head of Sales</p>' + (bio === 'linked' ? `<a href="${profile}">Dana Reyes on LinkedIn</a>` : '') + '</article>'
  const pages: Record<string, string> = {
    [origin + '/robots.txt']: 'User-agent: *\nAllow: /',
    [origin + '/']: wrap(`${prose}<p>${company}, 100 Example Ave, ${where} 78702</p><a href="/team">Team</a><a href="/contact">Contact</a>`),
    [origin + '/team']: wrap(prose + (bio === 'none' ? '' : '<h3><a href="/team/dana-reyes">Dana Reyes</a></h3>')),
    [origin + '/contact']: wrap(`${prose}<a href="mailto:sales@${host}">sales@${host}</a>`),
    [posting]: wrap(prose + '<h1>Account Executive</h1>'),
  }
  if (card) pages[origin + '/team/dana-reyes'] = wrap(card)
  const get: Get = async url => {
    assert.equal(new URL(url).hostname, host, 'only the company\'s own site is read; LinkedIn is never fetched')
    return { status: pages[url] ? 200 : 404, body: pages[url] ?? '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: { SITECRAWL_ENABLED: '1' } })
  extra(db, lead)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  const [l] = ((await (await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))).json()) as { leads: (PreviewLead & { company: string })[] }).leads
  const home = await (await readyGET(new NextRequest('http://test/api/home/ready'))).json() as { ready: number; held: { reason: string }[] }
  const person = leadPerson(l.enrichments, 'Head of Sales', undefined, identityOf({ id: l.id, contact: l.contact }, l.enrichments ?? []))
  return { l, home, person }
}
const assertHeld = (r: Awaited<ReturnType<typeof judged>>, what: string) => {
  assert.equal(r.person, null, `${what}: the row names nobody ("${NO_BUYER}")`)
  assert.equal(heldReason(r.l), NO_OWN_BUYER, `${what}: held because no buyer is named on the company's own site`)
  assert.equal(previewSplit([r.l]).opportunities.length, 0, `${what}: not an opportunity`)
  assert.equal(r.home.ready, 0, `${what}: Home's Ready tile does not count it`)
  assert.ok(r.home.held.some(h => h.reason === NO_OWN_BUYER), `${what}: Home says why: ${JSON.stringify(r.home.held)}`)
}

test('#1037 a lead whose company page names its buyer with a title and the LinkedIn profile that page links is READY, and the row names that buyer', async () => {
  const r = await judged('linked')
  assert.deepEqual(r.person, { name: 'Dana Reyes', title: 'Head of Sales', linkedin: profile, source: origin + '/team/dana-reyes', via: 'the company website (listed with this title)', current: true })
  assert.equal(heldReason(r.l), null, `held for: ${heldReason(r.l)}`)
  assert.deepEqual(previewSplit([r.l]).opportunities.map(o => o.company), [company])
  assert.equal(r.home.ready, 1, JSON.stringify(r.home))
})

test('#1037 every other lead is held, naming nobody: no one listed on the company site, a listed person with no LinkedIn link on the page, a public profile search result, a provider record', async () => {
  assertHeld(await judged('none'), 'nobody on the company site')
  assertHeld(await judged('no_link'), 'company bio without a LinkedIn link on the page')
  const at = Math.floor(Date.now() / 1000), day = new Date().toISOString().slice(0, 10)
  // the exact rows those producers store (lib/people/people-search.ts: a LinkedIn profile found by web search, tied to the company's domain;
  // lib/enrich: a provider contact with its LinkedIn field) - neither was read on the company's own pages
  assertHeld(await judged('none', (db, lead) => addEnrichment(db, 'A', lead, { connector: 'search:people', kind: 'person', value: 'Dana Reyes, Head of Sales', label: tiedLabel(PROFILE_SEARCH_LABEL, 'domain'), confidence: null, source_url: profile, source_date: day, retrieved_at: at })), 'a public profile search result')
  assertHeld(await judged('none', (db, lead) => addEnrichment(db, 'A', lead, { connector: 'enrich:pdl', kind: 'contact', value: 'Dana Reyes - Head of Sales', label: 'People Data Labs, record dated ' + day, confidence: null, source_url: profile, source_date: day, retrieved_at: at })), 'a provider record')
  // a profile search result never adds its LinkedIn to the company's own buyer either: the row keeps the own page's person without one, still held
  assertHeld(await judged('no_link', (db, lead) => addEnrichment(db, 'A', lead, { connector: 'search:people', kind: 'person', value: 'Dana Reyes, Head of Sales', label: tiedLabel(PROFILE_SEARCH_LABEL, 'domain'), confidence: null, source_url: profile, source_date: day, retrieved_at: at })), 'own-page person plus a searched LinkedIn')
})
