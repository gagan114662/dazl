// Proof for a hiring lead that quotes a posting's title line (PR #1694): the page must be ONE posting of the lead's company and
// carry that title. No network: every page is a stub, and the small model is a stub that counts how often it is asked.
// Every company, person and page here is invented (real job-board hosts, invented paths).
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead, companyOnPage, isShown, titleLineLead } from '../lib/discover/check.ts'
import { jobPostings, orgIsCompany, postingAddress, postingPage } from '../lib/discover/posting.ts'

const NOW = new Date('2026-11-24T12:00:00Z')
const BOARD = 'https://job-boards.greenhouse.io/northwinddental/jobs/4012345'
const hiring = (o: Record<string, unknown> = {}) => parseLeads(JSON.stringify({ leads: [{ company: 'Northwind Dental', domain: 'northwind-dental.example', signal: 'Hiring an Account Executive in Austin', signal_date: '2026-11-12', evidence_url: BOARD, evidence_quote: 'Account Executive',
  person: 'Dana Ruiz', title: 'Head of Sales', person_source_url: 'https://northwind-dental.example/team', linkedin_url: 'https://www.linkedin.com/in/dana-ruiz/', email: null, email_source_url: null, confidence: 'high', why: 'building a sales team', ...o }] }), 1).leads[0]
// servedFrom: the address the page finally answered at, when it is not the one asked for (a redirect)
const page = (body: string, servedFrom?: string) => (async () => { const r = new Response(body, { status: 200 }); if (servedFrom) Object.defineProperty(r, 'url', { value: servedFrom }); return r }) as unknown as typeof fetch
const never = (() => { throw new Error('must not be fetched') }) as unknown as typeof fetch
const judge = () => { const asked: string[][] = []; return { asked, ask: async (_signal: string, _company: string, statements: string[]) => { asked.push(statements); return true } } }
const state = (c: Awaited<ReturnType<typeof checkLead>>) => [c.proof, c.quote_on_page, c.signal_seen, isShown(c)]
const POSTING = '<html><head><title>Job Application for Account Executive at Northwind Dental</title></head><body><h1>Account Executive</h1><div>Austin, TX</div><p>Northwind Dental runs twelve clinics. You will sell our membership plan to employers.</p><button>Apply</button><aside><h3>Similar jobs</h3><ul><li>Sales Lead at Harbour Labs</li></ul></aside></body></html>'

test('one posting of the company on a known board, carrying the quoted title: shown, and the model is not asked', async () => {
  const j = judge()
  const c = await checkLead(hiring(), [], page(POSTING), 12_000, NOW, j.ask)
  assert.deepEqual([...state(c), c.signal_by, c.claim_lacks, j.asked.length], ['confirmed', true, true, true, 'posting', [], 0])
  // the board's name for the company is its first word, or an abbreviation with the company in the page's own title
  assert.equal(isShown(await checkLead(hiring({ evidence_url: 'https://jobs.lever.co/northwind/0a1b2c3d-1111-2222-3333-444455556666' }), [], page(POSTING), 12_000, NOW, j.ask)), true)
  assert.equal(isShown(await checkLead(hiring({ evidence_url: 'https://job-boards.greenhouse.io/nwd/jobs/4012345' }), [], page(POSTING), 12_000, NOW, j.ask)), true)
  // Claude's reader gave the text: the address and the text settle it with no read by dazl at all
  const viaReader = await checkLead(hiring(), [{ url: BOARD, title: 'Account Executive - Northwind Dental', page_age: null, text: 'Account Executive\nAustin, TX\nNorthwind Dental runs twelve clinics.' }], never, 12_000, NOW, j.ask)
  assert.deepEqual([viaReader.proof_read_by, viaReader.signal_by, isShown(viaReader), j.asked.length], ['reader', 'posting', true, 0])
})

test('the same title on a page that is not the company\'s one posting goes to review, whatever the model would say', async () => {
  const j = judge()   // answers YES to anything: before this rule, each of these pages was shown on that answer
  const review = async (o: Record<string, unknown>, body: string, why: string, servedFrom?: string) => {
    const c = await checkLead(hiring(o), [], page(body, servedFrom), 12_000, NOW, j.ask)
    assert.deepEqual([...state(c), c.signal_by], ['confirmed', true, false, false, undefined], why)
  }
  const list = '<html><head><title>Jobs at Northwind Dental</title></head><body><h1>Open roles at Northwind Dental</h1><ul><li><a href="/northwinddental/jobs/4012345">Account Executive</a></li><li><a href="/northwinddental/jobs/4012346">Sales Development Representative</a></li><li><a href="/northwinddental/jobs/4012347">Office Manager</a></li></ul></body></html>'
  await review({ evidence_url: 'https://job-boards.greenhouse.io/northwinddental' }, list, 'a board\'s list of openings')
  await review({}, list, 'a posting address that now answers with the board\'s list', 'https://job-boards.greenhouse.io/northwinddental?error=true')
  await review({ evidence_url: 'https://job-boards.greenhouse.io/harbourlabs/jobs/5550001' }, '<html><head><title>Job Application for Account Executive at Harbour Labs</title></head><body><h1>Account Executive</h1><p>Harbour Labs sells lab software.</p><button>Apply</button><aside><h3>Similar jobs</h3><ul><li>Account Executive at Northwind Dental</li></ul></aside></body></html>', 'another organisation\'s posting with the company in a side column')
  await review({ evidence_url: 'https://northwind-dental.example/team' }, '<html><head><title>Our team | Northwind Dental</title></head><body><h1>Our team</h1><ul><li>Dana Ruiz, Account Executive</li><li>Sam Patel, Practice Manager</li></ul><a href="/careers">Apply now</a></body></html>', 'a team page that prints a person\'s job title')
  await review({ evidence_url: 'https://news.example/northwind-grows' }, '<html><head><title>Northwind Dental grows</title></head><body><article><h1>Northwind Dental grows</h1><p>Northwind Dental said its new Account Executive will start in May.</p></article></body></html>', 'a news item that contains the title words')
  await review({ evidence_url: 'https://northwind-dental.example/careers' }, '<html><head><title>Careers | Northwind Dental</title></head><body><h1>Open roles</h1><ul><li><a href="/careers/account-executive">Account Executive</a></li><li><a href="/careers/office-manager">Office Manager</a></li></ul><a href="/apply">Apply</a></body></html>', 'the company\'s own list of openings')
  await review({ evidence_url: 'https://job-boards.greenhouse.io/nwd/jobs/4012345' }, '<html><head><title>Account Executive</title></head><body><h1>Account Executive</h1><p>We sell lab software.</p><aside>Similar jobs: Sales Lead at Northwind Dental</aside></body></html>', 'a board address that does not name the company, on a page whose title does not either')
  assert.equal(j.asked.length, 0, 'a title cannot state that a company is hiring: the model is never asked about one')
})

test('the page\'s own JobPosting record: shown when its hiring organisation is the company, on any host', async () => {
  const j = judge(), url = 'https://talent.example/p/88213'
  const html = (ld: unknown, body: string) => `<html><head><title>Account Executive</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Account Executive</h1>${body}</body></html>`
  const record = (org: unknown, title = 'Account Executive') => ({ '@context': 'https://schema.org', '@type': 'JobPosting', title, hiringOrganization: org, datePosted: '2026-11-10' })
  const ours = await checkLead(hiring({ evidence_url: url }), [], page(html(record({ '@type': 'Organization', name: 'Northwind Dental' }), '<p>Northwind Dental runs twelve clinics.</p>')), 12_000, NOW, j.ask)
  assert.deepEqual([...state(ours), ours.signal_by], ['confirmed', true, true, true, 'posting'])
  const bySite = await checkLead(hiring({ evidence_url: url }), [], page(html({ '@graph': [record({ name: 'NWD Holdings', sameAs: 'https://www.northwind-dental.example/' })] }, '<p>Northwind Dental runs twelve clinics.</p>')), 12_000, NOW, j.ask)
  assert.equal(isShown(bySite), true, 'the record names the company by its own site')
  const theirs = await checkLead(hiring({ evidence_url: url }), [], page(html(record({ '@type': 'Organization', name: 'Harbour Labs' }), '<p>Harbour Labs sells lab software.</p><aside>Also open: Account Executive at Northwind Dental</aside>')), 12_000, NOW, j.ask)
  assert.deepEqual(state(theirs), ['confirmed', true, false, false], 'a different hiring organisation')
  const several = await checkLead(hiring({ evidence_url: url }), [], page(html([record({ name: 'Northwind Dental' }), record({ name: 'Northwind Dental' }, 'Office Manager')], '<p>Northwind Dental runs twelve clinics.</p>')), 12_000, NOW, j.ask)
  assert.equal(isShown(several), false, 'records for several openings are a list, not one posting')
  // Claude's reader gave text only: dazl reads the page once for its record
  const seen = [{ url, title: 'Account Executive', page_age: null, text: 'Account Executive\nNorthwind Dental runs twelve clinics.' }]
  const viaReader = await checkLead(hiring({ evidence_url: url }), seen, page(html(record({ name: 'Northwind Dental' }), '<p>Northwind Dental runs twelve clinics.</p>')), 12_000, NOW, j.ask)
  assert.deepEqual([viaReader.proof_read_by, viaReader.signal_by, isShown(viaReader)], ['reader', 'posting', true])
  const goneSince = await checkLead(hiring({ evidence_url: url }), seen, page('<html><head><title>Northwind Dental</title></head><body><h1>Job not found</h1><p>This job is no longer available.</p></body></html>'), 12_000, NOW, j.ask)
  assert.deepEqual([goneSince.proof, isShown(goneSince)], ['gone', false], 'the reader\'s text was of a posting that has since been taken down')
  assert.equal(j.asked.length, 0)
  assert.deepEqual(jobPostings('<script type="application/ld+json">{not json</script><script type="application/ld+json">{"@type":["JobPosting"],"name":"Office Manager","hiringOrganization":"Northwind Dental"}</script>'), [{ title: 'Office Manager', org: 'Northwind Dental', orgUrls: [] }])
})

test('the company\'s own site: one opening\'s page is a posting; its heading must be the role', async () => {
  const j = judge()
  const own = (path: string, body: string) => checkLead(hiring({ evidence_url: `https://northwind-dental.example${path}` }), [], page(`<html><head><title>Account Executive | Northwind Dental</title></head><body>${body}</body></html>`), 12_000, NOW, j.ask)
  assert.equal(isShown(await own('/careers/account-executive', '<h1>Account Executive</h1><p>Join Northwind Dental in Austin.</p>')), true, 'a careers path that ends in the opening')
  assert.equal(isShown(await own('/work/ae-austin', '<h1>Account Executive</h1><p>Join Northwind Dental in Austin.</p><a class="btn" href="/apply/17"><span>Apply for this job</span></a>')), true, 'the role as the heading, with an Apply control')
  assert.equal(isShown(await own('/work/ae-austin', '<h1>Account Executive</h1><p>Join Northwind Dental in Austin.</p>')), false, 'neither a careers path nor an Apply control')
  const quoted = await checkLead(hiring({ evidence_url: 'https://northwind-dental.example/careers/account-executive', evidence_quote: 'Account Executive - Austin, TX' }), [], page('<html><head><title>Northwind Dental</title></head><body><h1>Account Executive</h1><p>Account Executive - Austin, TX</p><p>Join Northwind Dental.</p></body></html>'), 12_000, NOW, j.ask)
  assert.equal(isShown(quoted), true, 'the heading is the role and the quoted line adds the place')
  assert.equal(j.asked.length, 0)
})

test('a posting that is gone is still gone', async () => {
  const c = await checkLead(hiring(), [], page('<html><head><title>Northwind Dental</title></head><body><h1>Job not found</h1><p>This job is no longer available. See all open roles at Northwind Dental.</p></body></html>'), 12_000, NOW, judge().ask)
  assert.deepEqual([c.proof, c.signal_seen, isShown(c)], ['gone', false, false])
  const notFound = await checkLead(hiring(), [], (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch, 12_000, NOW)
  assert.equal(notFound.proof, 'gone')
})

test('a short title is found only on a real posting page, and only as a line of its own', async () => {
  const j = judge(), sdr = { signal: 'Hiring an SDR', evidence_quote: 'SDR' }
  const real = await checkLead(hiring(sdr), [], page('<html><head><title>Job Application for SDR at Northwind Dental</title></head><body><h1>SDR</h1><p>Northwind Dental runs twelve clinics.</p><button>Apply</button></body></html>'), 12_000, NOW, j.ask)
  assert.deepEqual([...state(real), real.signal_by], ['confirmed', true, true, true, 'posting'])
  const news = await checkLead(hiring({ ...sdr, evidence_url: 'https://news.example/northwind-grows' }), [], page('<html><body><h1>SDR</h1><p>Northwind Dental grew its SDR team this year.</p></body></html>'), 12_000, NOW, j.ask)
  assert.deepEqual(state(news), ['confirmed', false, false, false], 'elsewhere a short title is not looked for at all')
  const buried = await checkLead(hiring(sdr), [], page('<html><head><title>Northwind Dental careers</title></head><body><p>At Northwind Dental every SDR works with two account executives and one manager and earns a base salary plus commission.</p></body></html>'), 12_000, NOW, j.ask)
  assert.deepEqual(state(buried), ['confirmed', false, false, false], 'on a posting page, a short title inside a paragraph is not the posting\'s title')
  assert.equal(j.asked.length, 0)
})

test('a quote that is a sentence keeps the rules it had: the words decide, then the model is asked', async () => {
  const j = judge()
  // the same lead and page as 'real signal pages stay shown' in discover-agent.test.ts
  const news = parseLeads(JSON.stringify({ leads: [{ ...hiring(), signal: 'Opening a second clinic', signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind-second-clinic', evidence_quote: 'Northwind Dental will open its second clinic' }] }), 1).leads[0]
  const shown = await checkLead(news, [], page('<article><h1>Northwind Dental grows</h1><p>The practice said Northwind Dental will open its second clinic on King Street next spring, adding six chairs.</p></article>'), 12_000, NOW, j.ask)
  assert.deepEqual([...state(shown), shown.signal_by, j.asked.length], ['confirmed', true, true, true, undefined, 0])
  // a hiring lead that quotes a sentence, on a page that is no posting: the words settle it, as before
  const sentence = hiring({ signal: 'Hiring an Account Executive', evidence_url: 'https://news.example/northwind-hiring', evidence_quote: 'Northwind Dental is hiring an Account Executive' })
  assert.equal(titleLineLead(sentence), false)
  const byWords = await checkLead(sentence, [], page('<html><body><p>Northwind Dental is hiring an Account Executive.</p></body></html>'), 12_000, NOW, j.ask)
  assert.deepEqual([...state(byWords), byWords.signal_by, j.asked.length], ['confirmed', true, true, true, undefined, 0])
  // words unsettled: the model is still asked, once, with the page's own statement
  const long = hiring({ signal: 'Hiring an Account Executive in Austin to sell its employer plan, posted 4 days ago', evidence_url: 'https://news.example/northwind-hiring', evidence_quote: 'Northwind Dental is hiring an Account Executive' })
  const asked = await checkLead(long, [], page('<html><body><p>Northwind Dental is hiring an Account Executive.</p></body></html>'), 12_000, NOW, j.ask)
  assert.deepEqual([...state(asked), asked.signal_by, j.asked], ['confirmed', true, true, true, 'claude', [['Northwind Dental is hiring an Account Executive.']]])
  // which leads the posting rule governs: a hiring signal AND a quote that reads as a title
  assert.equal(titleLineLead(hiring()), true)
  assert.equal(titleLineLead(hiring({ evidence_quote: 'Account Executive - Austin, TX' })), true)
  assert.equal(titleLineLead(hiring({ signal: 'Opening a second clinic' })), false, 'not a hiring signal')
  assert.equal(titleLineLead(hiring({ evidence_quote: 'We are growing our sales team' })), false)
  assert.equal(titleLineLead(hiring({ evidence_quote: null })), false)
})

test('which addresses are one posting, and whose', () => {
  const org = (u: string) => postingAddress(new URL(u))?.org
  assert.deepEqual([
    'https://boards.greenhouse.io/northwind/jobs/4012345?gh_src=x', 'https://jobs.lever.co/northwind/0a1b2c3d-1111-2222-3333-444455556666/apply', 'https://jobs.ashbyhq.com/northwind/0a1b2c3d-1111-2222-3333-444455556666',
    'https://apply.workable.com/northwind/j/A1B2C3D4E5', 'https://jobs.smartrecruiters.com/Northwind/743999912345678-account-executive', 'https://northwind.recruitee.com/o/account-executive',
    'https://northwind.teamtailor.com/jobs/123456-account-executive', 'https://northwind.bamboohr.com/careers/42', 'https://northwind.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Account-Executive_R-1001',
    'https://www.ycombinator.com/companies/northwind/jobs/AbC123-account-executive',
  ].map(org), ['northwind', 'northwind', 'northwind', 'northwind', 'Northwind', 'northwind', 'northwind', 'northwind', 'northwind', 'northwind'])
  assert.deepEqual(postingAddress(new URL('https://www.linkedin.com/jobs/view/4012345678')), { board: 'other', host: 'linkedin.com', org: null, id: '4012345678' })
  for (const list of ['https://job-boards.greenhouse.io/northwind', 'https://jobs.lever.co/northwind', 'https://jobs.ashbyhq.com/northwind', 'https://apply.workable.com/northwind/', 'https://northwind.recruitee.com/', 'https://northwind.teamtailor.com/jobs',
    'https://northwind.bamboohr.com/careers', 'https://northwind.wd5.myworkdayjobs.com/en-US/External', 'https://www.ycombinator.com/companies/northwind/jobs', 'https://www.linkedin.com/jobs/search?keywords=account%20executive', 'https://northwind-dental.example/careers/account-executive'])
    assert.equal(postingAddress(new URL(list)), null, list)
  assert.equal(orgIsCompany('northwinddental', 'Northwind Dental', null), true)
  assert.equal(orgIsCompany('northwind', 'Northwind Dental Inc.', null), true, 'the first word of the name')
  assert.equal(orgIsCompany('Northwind-Dental', 'Northwind Dental', null), true)
  assert.equal(orgIsCompany('nwd', 'Northwind Dental', 'nwd.example'), true, 'the company\'s own domain')
  assert.equal(orgIsCompany('harbourlabs', 'Northwind Dental', 'northwind-dental.example'), false)
  assert.equal(orgIsCompany('nor', 'Nor Thwind Dental', null), false, 'three letters of a longer name are not the company')
  const input = (url: string, o: Partial<Parameters<typeof postingPage>[0]> = {}): Parameters<typeof postingPage>[0] => ({ url: new URL(url), company: 'Northwind Dental', domain: 'northwind-dental.example', quote: 'Account Executive', html: null, text: 'Account Executive\nNorthwind Dental\nApply now', pageTitle: 'Account Executive | Northwind Dental', names: (t: string) => companyOnPage('Northwind Dental', t), ...o })
  assert.equal(postingPage(input('https://www.linkedin.com/jobs/view/4012345678', { pageTitle: 'Northwind Dental hiring Account Executive in Austin' })), true, 'no organisation in the address: the page\'s title names the company')
  assert.equal(postingPage(input('https://www.linkedin.com/jobs/view/4012345678', { pageTitle: 'Account Executive in Austin' })), false)
  assert.equal(postingPage(input('https://northwind-dental.example/work/ae')), true, 'text only: the title the run saw is the role, and the text has an Apply line')
  assert.equal(postingPage(input('https://northwind-dental.example/work/ae', { text: 'Account Executive\nNorthwind Dental' })), false)
  assert.equal(postingPage(input('https://northwind-dental.example/careers/search?q=account+executive')), false, 'a search-results address is never one posting')
  assert.equal(postingPage(input('https://northwind-dental.example/careers/page/2', { text: 'Account Executive\nNorthwind Dental' })), false, 'a page of a list')
  assert.equal(postingPage(input('https://other.example/careers/account-executive')), false, 'not the company\'s site')
})
