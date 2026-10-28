// Open sales role on the company's own careers page. Stubbed pages, invented companies, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { careersSalesVacancy, salesRoleTitles } from '../lib/signals/careers-page.ts'

const page = (body: string) => `<html><body>${body}</body></html>`
const site = (pages: Record<string, string>, over: Record<string, { status: number; body: string; finalUrl?: string } | null> = {}) => async (url: string) => {
  const u = new URL(url); const key = u.pathname
  if (key in over) { const o = over[key]; return o ? { status: o.status, body: o.body, finalUrl: o.finalUrl ?? url } : null }
  if (key === '/robots.txt') return { status: 404, body: '', finalUrl: url }
  return key in pages ? { status: 200, body: page(pages[key]), finalUrl: url } : { status: 404, body: '', finalUrl: url }
}
const NOW = Date.parse('2026-10-28T12:00:00Z')

test('an open Account Executive role with an apply link on the own careers page is a vacancy: URL, quote and retrieval time are saved', async () => {
  const r = await careersSalesVacancy('brightloop.io', site({ '/careers': '<h2>Open roles</h2><ul><li>Backend Engineer</li><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul>' }), { now: NOW })
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
  const none = (pages: Record<string, string>) => careersSalesVacancy('brightloop.io', site(pages), { now: NOW })
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
    ['<li><a href="https://boards.greenhouse.io/brightloop/jobs/123">Account Executive</a></li>', 'https://boards.greenhouse.io/brightloop/jobs/123'],
    ['<li><a href="https://jobs.lever.co/brightloop/6f1e0c2a-1111-2222-3333-444455556666">Head of Sales</a></li>', 'https://jobs.lever.co/brightloop/6f1e0c2a-1111-2222-3333-444455556666'],
    ['<li><a href="https://jobs.ashbyhq.com/brightloop/abcd1234">Sales Manager</a></li>', 'https://jobs.ashbyhq.com/brightloop/abcd1234'],
  ] as const) { const r = await none({ '/careers': html }); assert.equal(r.vacancy?.url, url, html) }
})
