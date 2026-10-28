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
  assert.equal(r.reason, 'found'); assert.equal(r.vacancy!.title, 'Account Executive - London'); assert.equal(r.vacancy!.url, 'https://brightloop.io/careers')
  assert.match(r.vacancy!.quote, /Account Executive - London/); assert.equal(r.vacancy!.retrievedAt, Math.floor(NOW / 1000))
})
test('negative controls: engineering-only roles, a hiring sentence, no apply cue, closed markers, no careers page, wrong-domain redirect and robots all give NO vacancy', async () => {
  const none = async (pages: Record<string, string>, over = {}) => careersSalesVacancy('brightloop.io', site(pages, over), { now: NOW })
  assert.equal((await none({ '/careers': '<h2>Open roles</h2><li>Backend Engineer</li><li>Data Scientist</li> Apply' })).reason, 'no_open_sales_role')
  assert.equal((await none({ '/careers': '<p>We are doubling engineering and accelerating our go-to-market. Apply soon.</p>' })).reason, 'no_open_sales_role', 'generic GTM plans are not a vacancy')
  assert.equal((await none({ '/careers': '<li>Account Executive</li>' })).reason, 'no_open_sales_role', 'a title with no way to apply')
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
