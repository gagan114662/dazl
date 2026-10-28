// Open sales role on the company's own careers page. Stubbed pages, invented companies, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { careersSalesVacancy, salesRoleTitles, roleAgrees } from '../lib/signals/careers-page.ts'

const page = (body: string) => `<html><body>${body}</body></html>`
const site = (pages: Record<string, string>, over: Record<string, { status: number; body: string; finalUrl?: string } | null> = {}) => async (url: string) => {
  const u = new URL(url); const key = u.hostname === 'brightloop.io' ? u.pathname : u.hostname + u.pathname
  if (key in over) { const o = over[key]; return o ? { status: o.status, body: o.body, finalUrl: o.finalUrl ?? url } : null }
  if (key === '/robots.txt') return { status: 404, body: '', finalUrl: url }
  return key in pages ? { status: 200, body: page(pages[key]), finalUrl: url } : { status: 404, body: '', finalUrl: url }
}
const NOW = Date.parse('2026-10-28T12:00:00Z')
const JOB = (title = 'Account Executive - London', extra = '') => `<h1>${title}</h1><p>Join Brightloop in London as ${title}. ${extra}</p><a href="/careers/apply">Apply</a>`

test('an open Account Executive role with an apply link on the own careers page is a vacancy: URL, quote and retrieval time are saved', async () => {
  const r = await careersSalesVacancy('brightloop.io', site({ '/careers': '<h2>Open roles</h2><ul><li>Backend Engineer</li><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul>', '/careers/ae': JOB() }), { now: NOW, company: 'Brightloop' })
  assert.equal(r.reason, 'found'); assert.equal(r.vacancy!.title, 'Account Executive - London'); assert.equal(r.vacancy!.url, 'https://brightloop.io/careers/ae', 'the saved URL is the specific job, not the careers index')
  assert.match(r.vacancy!.quote, /Account Executive - London/); assert.equal(r.vacancy!.retrievedAt, Math.floor(NOW / 1000))
})
test('negative controls: engineering-only roles, a hiring sentence, no apply cue, closed markers, no careers page, wrong-domain redirect and robots all give NO vacancy', async () => {
  const none = async (pages: Record<string, string>, over = {}) => careersSalesVacancy('brightloop.io', site(pages, over), { now: NOW })
  assert.equal((await none({ '/careers': '<h2>Open roles</h2><li>Backend Engineer</li><li>Data Scientist</li> Apply' })).reason, 'no_open_sales_role')
  assert.equal((await none({ '/careers': '<p>We are doubling engineering and accelerating our go-to-market. Apply soon.</p>' })).reason, 'no_open_sales_role', 'generic GTM plans are not a vacancy')
  assert.equal((await none({ '/careers': '<li>Account Executive</li>' })).reason, 'no_open_sales_role', 'a title with no way to apply')
  assert.equal((await none({ '/careers': '<li>Account Executive</li> Apply' })).reason, 'no_open_sales_role', 'the word Apply with no link to that job')
  assert.equal((await none({ '/careers': '<h2>Careers</h2><p>There are no open positions right now.</p>' })).reason, 'closed_marker')
  assert.equal((await none({ '/careers': '<li>Account Executive</li> <span>This position has been filled.</span> Apply' })).reason, 'closed_marker')
  assert.equal((await none({})).reason, 'no_careers_page')
  assert.equal((await none({}, { '/careers': { status: 200, body: page('<li>Account Executive</li> Apply'), finalUrl: 'https://othercorp.com/careers' } })).reason, 'wrong_domain')
  assert.equal((await none({ '/careers': '<li>Sales Manager</li> Apply' }, { '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' } })).reason, 'robots_disallow')
  assert.equal((await none({ '/careers': '<li>Sales Manager</li> Apply' }, { '/robots.txt': null })).reason, 'robots_unreachable')
  assert.equal((await none({ '/careers': '<li>Salesforce Developer</li> Apply' })).reason, 'no_open_sales_role')
})
test('title extraction keeps role-shaped titles only', () => {
  assert.deepEqual(salesRoleTitles('<li>Sales Development Representative</li><p>We are hiring sales people to grow.</p><li>Head of Sales</li>'), ['Sales Development Representative', 'Head of Sales'])
})

test('Instinct review: closed wording and non-job "apply" links do not make a vacancy (failing before, passing after)', async () => {
  const none = (pages: Record<string, string>) => careersSalesVacancy('brightloop.io', site({ '/careers/ae': JOB('Account Executive'), ...pages }), { now: NOW, company: 'Brightloop' })
  // 1. "Not currently hiring; past positions" followed by an Account Executive and "Apply for job alerts"
  const a = await none({ '/careers': '<h1>Careers at Brightloop</h1><p>Not currently hiring; past positions:</p><ul><li>Account Executive</li></ul><a href="/alerts">Apply for job alerts</a>' })
  assert.equal(a.vacancy, null); assert.equal(a.reason, 'closed_marker')
  // 2. an "Our team" Account Executive listing beside "Apply for our newsletter"
  const b = await none({ '/careers': '<h1>Our team</h1><div><h3>Jordan Lee</h3><p>Account Executive</p></div><a href="/newsletter">Apply for our newsletter</a>' })
  assert.equal(b.vacancy, null); assert.equal(b.reason, 'no_open_sales_role')
  // near variants
  for (const html of [
    '<h2>Open roles</h2><li>Account Executive</li><a href="/careers">Apply</a>',                                  // apply link goes to the careers index
    '<h2>Open roles</h2><li>Account Executive</li><a href="mailto:jobs@brightloop.io">Apply</a>',                  // an e-mail is not a job route
    '<h2>Open roles</h2><li>Account Executive</li><a href="/careers/talent-network">Apply to our talent network</a>',
    '<h2>Open roles</h2><li>Account Executive</li><a href="https://othercorp.com/jobs/123">Apply</a>',             // another site
    '<p>No open roles at the moment.</p><li><a href="/careers/ae">Account Executive</a></li>',
    '<p>The position has been filled.</p><li><a href="/careers/ae">Account Executive</a></li>',
    '<p>Check back soon for new openings.</p><li><a href="/careers/ae">Account Executive</a></li>',
    '<h3>Previous roles</h3><li><a href="/careers/ae">Account Executive</a></li>',
    '<p>We are not actively hiring.</p><li><a href="/careers/ae">Account Executive</a></li>',
  ]) assert.equal((await none({ '/careers': html })).vacancy, null, html)
  // controls: the role links to its own job page; an apply link to that job; a public Greenhouse / Lever / Ashby posting
  for (const [html, url] of [
    ['<li><a href="/careers/account-executive">Account Executive</a></li>', 'https://brightloop.io/careers/account-executive'],
    ['<li>Sales Development Representative</li> <a href="/jobs/4821">Apply now</a>', 'https://brightloop.io/jobs/4821'],
  ] as const) { const r = await careersSalesVacancy('brightloop.io', site({ '/careers': html, '/careers/account-executive': JOB('Account Executive'), '/jobs/4821': JOB('Sales Development Representative') }), { now: NOW, company: 'Brightloop' }); assert.equal(r.vacancy?.url, url, html) }
})

// ---- Instinct review of 987d3d8: the selected job must be fetched and verified; never fall back to the careers-index link ----
const GHJ = 'boards-api.greenhouse.io/v1/boards'
const ok = (b: unknown) => ({ status: 200, body: JSON.stringify(b) })
test('a stale careers-index link: the job page says "This position is closed." (or 404s / redirects away / no longer shows the role) -> NO vacancy, no fallback to the index', async () => {
  const idx = '<h1>Careers at Brightloop</h1><ul><li><a href="/careers/ae">Account Executive</a></li></ul>'
  const run = (jobPage: string | undefined, over: Record<string, { status: number; body: string; finalUrl?: string } | null> = {}) => careersSalesVacancy('brightloop.io', site({ '/careers': idx, ...(jobPage === undefined ? {} : { '/careers/ae': jobPage }) }, over), { now: NOW, company: 'Brightloop' })
  const closed = await run('<h1>Account Executive</h1><p>This position is closed.</p>'); assert.equal(closed.vacancy, null); assert.equal(closed.reason, 'job_closed')
  assert.equal((await run('<h1>Account Executive</h1><p>This role has been filled. Brightloop thanks everyone who applied.</p>')).reason, 'job_closed')
  assert.equal((await run('<h1>Account Executive</h1><p>This job posting has expired.</p>')).vacancy, null)
  assert.equal((await run(undefined)).reason, 'job_closed', '404 job page')
  assert.equal((await run(undefined, { '/careers/ae': { status: 410, body: '' } })).reason, 'job_closed', '410 job page')
  assert.equal((await run(undefined, { '/careers/ae': { status: 200, body: '<h1>All open roles</h1>', finalUrl: 'https://brightloop.io/careers' } })).reason, 'job_closed', 'redirected to a listing that no longer shows the role')
  assert.equal((await run('<h1>Careers</h1><p>Browse all roles</p>')).reason, 'job_role_mismatch', 'the job page does not show the role')
  assert.equal((await run(undefined, { '/careers/ae': { status: 200, body: '<h1>Account Executive</h1>', finalUrl: 'https://othercorp.com/x' } })).reason, 'job_company_mismatch')
  assert.equal((await run(JOB('Account Executive'))).reason, 'found', 'control: the same index with an open, company-named job page is a vacancy')
})
test('ATS links are fetched and verified: another company\'s Lever / Greenhouse / Ashby job, a closed posting, or an unlisted job is rejected; the lead\'s own open posting is accepted', async () => {
  const run = (link: string, over: Record<string, { status: number; body: string } | null>) => careersSalesVacancy('brightloop.io', site({ '/careers': `<h1>Careers</h1><li><a href="${link}">Account Executive</a></li>` }, over), { now: NOW, company: 'Brightloop' })
  const UUID = '6f1e0c2a-1111-2222-3333-444455556666'
  // Lever
  const lever = `https://jobs.lever.co/othercorp/${UUID}`
  const other = await run(lever, { [`api.lever.co/v0/postings/othercorp/${UUID}`]: ok({ id: UUID, text: 'Account Executive', hostedUrl: lever, descriptionPlain: 'Join Othercorp, a Berlin logistics company.' }) })
  assert.equal(other.vacancy, null); assert.equal(other.reason, 'job_company_mismatch', 'another company\'s Lever job')
  assert.equal((await run(lever, {})).reason, 'job_closed', 'unfetchable / 404 Lever posting is closed')
  const own = `https://jobs.lever.co/brightloop/${UUID}`
  assert.equal((await run(own, { [`api.lever.co/v0/postings/brightloop/${UUID}`]: ok({ id: UUID, text: 'Account Executive', hostedUrl: own, descriptionPlain: 'Join Brightloop.' }) })).vacancy?.url, own, 'control: the lead\'s own open Lever job')
  assert.equal((await run(own, { [`api.lever.co/v0/postings/brightloop/${UUID}`]: ok({ id: UUID, text: 'Account Executive', hostedUrl: own, descriptionPlain: 'This position is closed.' }) })).reason, 'job_closed')
  // a differently named board that the posting itself ties to the company is accepted
  const alias = `https://jobs.lever.co/brightloop-ltd/${UUID}`
  assert.equal((await run(alias, { [`api.lever.co/v0/postings/brightloop-ltd/${UUID}`]: ok({ id: UUID, text: 'Account Executive', hostedUrl: alias, descriptionPlain: 'Brightloop is hiring in London.' }) })).vacancy?.url, alias)
  // Greenhouse
  const gh = 'https://boards.greenhouse.io/othercorp/jobs/123'
  assert.equal((await run(gh, { [`${GHJ}/othercorp/jobs/123`]: ok({ id: 123, title: 'Account Executive', content: '&lt;p&gt;Join Othercorp&lt;/p&gt;' }) })).reason, 'job_company_mismatch', 'another company\'s Greenhouse job')
  assert.equal((await run(gh, { [`${GHJ}/othercorp/jobs/123`]: { status: 404, body: '' } })).reason, 'job_closed')
  const ghOwn = 'https://boards.greenhouse.io/brightloop/jobs/321'
  assert.equal((await run(ghOwn, { [`${GHJ}/brightloop/jobs/321`]: ok({ id: 321, title: 'Account Executive', content: '&lt;p&gt;Join Brightloop&lt;/p&gt;' }) })).vacancy?.url, ghOwn)
  // Ashby
  const ab = 'https://jobs.ashbyhq.com/othercorp/abcd1234'
  const board = (org: string, jobs: unknown[]) => ({ [`api.ashbyhq.com/posting-api/job-board/${org}`]: ok({ jobs }) })
  assert.equal((await run(ab, board('othercorp', [{ title: 'Account Executive', jobUrl: ab, isListed: true, descriptionPlain: 'Othercorp builds boats.' }]))).reason, 'job_company_mismatch', 'another company\'s Ashby job')
  assert.equal((await run(ab, board('othercorp', []))).reason, 'job_closed', 'no longer on the board')
  const abOwn = 'https://jobs.ashbyhq.com/brightloop/abcd1234'
  assert.equal((await run(abOwn, board('brightloop', [{ title: 'Account Executive', jobUrl: abOwn, isListed: false }]))).reason, 'job_closed', 'unlisted')
  assert.equal((await run(abOwn, board('brightloop', [{ title: 'Account Executive', jobUrl: abOwn, isListed: true, descriptionPlain: 'Brightloop' }]))).vacancy?.url, abOwn)
})

// ---- Instinct review of a74f8a6: the role comes from the fetched posting, and it must be a sales / GTM role that agrees with the index claim ----
test('wrong role behind a sales label: the index says Account Executive, the company-owned posting is a Backend Engineer -> rejected on every adapter (failing on a74f8a6); matching sales postings accepted', async () => {
  const UUID = '6f1e0c2a-1111-2222-3333-444455556666'
  const run = (link: string, over: Record<string, { status: number; body: string } | null>, pages: Record<string, string> = {}) => careersSalesVacancy('brightloop.io', site({ '/careers': `<h1>Careers</h1><li><a href="${link}">Account Executive</a></li>`, ...pages }, over), { now: NOW, company: 'Brightloop' })
  // same-domain detail page
  const wrong = await run('/careers/ae', {}, { '/careers/ae': JOB('Backend Engineer') })
  assert.equal(wrong.vacancy, null); assert.equal(wrong.reason, 'job_role_mismatch')
  assert.equal((await run('/careers/ae', {}, { '/careers/ae': JOB('Senior Account Executive, EMEA') })).vacancy?.title, 'Senior Account Executive, EMEA', 'control: the posting\'s own title is saved, and a level / region of the same role agrees')
  assert.equal((await run('/careers/ae', {}, { '/careers/ae': JOB('Sales Operations Analyst') })).reason, 'job_role_mismatch', 'a different sales-adjacent role is not the claimed Account Executive')
  assert.equal((await run('/careers/ae', {}, { '/careers/ae': '<html><body><p>Join Brightloop.</p></body></html>' })).reason, 'job_unverified', 'no heading to read the role from')
  // Lever
  const lever = `https://jobs.lever.co/brightloop/${UUID}`, LV = `api.lever.co/v0/postings/brightloop/${UUID}`
  assert.equal((await run(lever, { [LV]: ok({ id: UUID, text: 'Backend Engineer', hostedUrl: lever, descriptionPlain: 'Join Brightloop.' }) })).reason, 'job_role_mismatch', 'Lever')
  const lok = await run(lever, { [LV]: ok({ id: UUID, text: 'Account Executive', hostedUrl: lever, descriptionPlain: 'Join Brightloop.' }) })
  assert.deepEqual([lok.vacancy?.title, lok.vacancy?.url], ['Account Executive', lever])
  // Greenhouse
  const gh = 'https://boards.greenhouse.io/brightloop/jobs/321'
  assert.equal((await run(gh, { [`${GHJ}/brightloop/jobs/321`]: ok({ id: 321, title: 'Backend Engineer', content: '&lt;p&gt;Join Brightloop&lt;/p&gt;' }) })).reason, 'job_role_mismatch', 'Greenhouse')
  assert.equal((await run(gh, { [`${GHJ}/brightloop/jobs/321`]: ok({ id: 321, title: 'Account Executive - London', content: '&lt;p&gt;Join Brightloop&lt;/p&gt;' }) })).vacancy?.title, 'Account Executive - London')
  // Ashby
  const ab = 'https://jobs.ashbyhq.com/brightloop/abcd1234', board = (title: string) => ({ 'api.ashbyhq.com/posting-api/job-board/brightloop': ok({ jobs: [{ title, jobUrl: ab, isListed: true, descriptionPlain: 'Brightloop' }] }) })
  assert.equal((await run(ab, board('Backend Engineer'))).reason, 'job_role_mismatch', 'Ashby')
  assert.equal((await run(ab, board('Account Executive'))).vacancy?.title, 'Account Executive')
  // role agreement itself
  assert.equal(roleAgrees('Account Executive', 'Backend Engineer'), false); assert.equal(roleAgrees('Account Executive', 'Account Executive - London'), true)
  assert.equal(roleAgrees('Backend Engineer', 'Backend Engineer'), false, 'agreeing but not a sales / GTM role')
  assert.equal(roleAgrees('Head of Sales', 'Account Executive'), false)
})
