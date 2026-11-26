// #1122: the dazl LinkedIn Reader's page reading, run on invented card records (unit only: not proof of LinkedIn's live markup,
// which is checked by the user loading the extension). Also pins the manifest to read-only permissions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const dir = fileURLToPath(new URL('../../extension/', import.meta.url))
type Extract = { people: (r: unknown[]) => unknown[]; postEngagers: (r: unknown[]) => Record<string, unknown>[]; companyPosts: (r: unknown[]) => { url: string; date: string | null }[]; postUrl: (h: string) => string | null; postDate: (s: string) => string | null; blockedReason: (h: string) => string | null; pageProblem: (p: Record<string, unknown>) => string | null }
const ctx: { dazlExtract?: Extract; URL: typeof URL } = { URL }
vm.createContext(ctx)
vm.runInContext(readFileSync(dir + 'extract.js', 'utf8'), ctx)
const X = ctx.dazlExtract as Extract

test('people: name, title and own profile URL; badges, screen-reader repeats, hidden members and duplicates dropped', () => {
  const got = X.people([
    { href: '/in/jane-doe-12/?miniProfileUrn=x', name: 'Jane Doe • 2nd', title: '  VP Sales   at Acme ' },
    { href: 'https://www.linkedin.com/in/jane-doe-12/', name: 'Jane Doe', title: 'VP Sales' },
    { href: '/in/sam-roe/', name: 'Sam RoeSam Roe', title: 'Head of Revenue' },
    { href: '/in/x1/', name: 'LinkedIn Member', title: 'Sales' },
    { href: '/in/no-title/', name: 'No Title', title: '' },
    { href: '/company/acme/', name: 'Acme', title: 'Company' },
    { href: 'https://evil.example/in/fake/', name: 'Fake', title: 'CEO' },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [
    { name: 'Jane Doe', title: 'VP Sales at Acme', profile_url: 'https://www.linkedin.com/in/jane-doe-12/' },
    { name: 'Sam Roe', title: 'Head of Revenue', profile_url: 'https://www.linkedin.com/in/sam-roe/' },
  ])
})

test('blocked pages are named, not read', () => {
  assert.equal(X.blockedReason('https://www.linkedin.com/checkpoint/challenge/abc'), 'challenge')
  assert.equal(X.blockedReason('https://www.linkedin.com/authwall?trk=x'), 'login_required')
  assert.equal(X.blockedReason('https://www.linkedin.com/login'), 'login_required')
  assert.equal(X.blockedReason('https://www.linkedin.com/company/acme/people/'), null)
})

test('manifest: MV3, read-only permissions (no cookies, no scripting, no webRequest), LinkedIn + dazl hosts only', () => {
  const m = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'))
  assert.equal(m.manifest_version, 3)
  assert.deepEqual([...m.permissions].sort(), ['alarms', 'storage'])
  for (const h of m.host_permissions) assert.match(h, /^https:\/\/(www\.linkedin\.com|dazl\.ai|www\.dazl\.ai|staging\.dazl\.ai)\/\*$/)
  const content = readFileSync(dir + 'content.js', 'utf8')
  assert.doesNotMatch(content, /\.click\(|dispatchEvent|fetch\(/)   // reads only: no clicks, no requests from the page
})

test('#1588 postEngagers: a commenter carries their own comment, a like row is marked, an old plain record stays a commenter', () => {
  const got = X.postEngagers([
    { href: '/in/jane-doe-12/', name: 'Jane Doe • 2nd', title: 'VP Sales at Acme', comment: '  Why does it   always crash? ' },
    { href: '/in/sam-roe/', name: 'Sam Roe', title: 'Head of Revenue', action: 'like' },
    { href: '/in/old-build/', name: 'Old Build', title: 'CEO', },
    { href: '/in/jane-doe-12/', name: 'Jane Doe', title: 'VP Sales at Acme', comment: 'duplicate URL' },
    { href: '/in/hidden/', name: 'LinkedIn Member', title: 'Sales', comment: 'x' },
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [
    { name: 'Jane Doe', title: 'VP Sales at Acme', profile_url: 'https://www.linkedin.com/in/jane-doe-12/', action: 'comment', comment: 'Why does it always crash?' },
    { name: 'Sam Roe', title: 'Head of Revenue', profile_url: 'https://www.linkedin.com/in/sam-roe/', action: 'like' },
    { name: 'Old Build', title: 'CEO', profile_url: 'https://www.linkedin.com/in/old-build/', action: 'comment' },
  ])
})

test('#1588 companyPosts: only the page\u2019s own post links, once each, with the date the page showed or none', () => {
  const got = X.companyPosts([
    { href: '/posts/acme_sales-activity-7212345678901234567-AbCd?trk=x', date: '2026-11-20T14:03:00.000Z' },
    { href: 'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234567-AbCd/', date: '3w' },
    { href: '/feed/update/urn:li:activity:7212345678901234569/', date: '2d' },
    { href: '/company/acme/', date: '2026-11-20' },          // a company link is not a post
    { href: '/posts/acme_sales-activity-7212345678901234570-Zz/', date: '' },   // no date shown: kept, undated
    { href: 'https://news.example/x', date: '2026-11-20' },  // not LinkedIn
  ])
  const urls = JSON.parse(JSON.stringify(got.map(p => p.url))) as string[]
  assert.deepEqual(urls, [
    'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234567-AbCd/',
    'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234569/',
    'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234570-Zz/',
  ])
  assert.equal(got[0].date, '2026-11-20', 'a full timestamp is its calendar day')
  assert.equal(got.length, 3, 'the duplicate post link is read once, non-posts are never read')
  assert.match(String(got[1].date), /^\d{4}-\d{2}-\d{2}$/, 'a relative "2d" is the day it names, not a guess')
  assert.equal(got[2].date, null, 'no date on the page is no date, never invented')
})

test('#1588 postDate: what the page shows, or nothing', () => {
  assert.equal(X.postDate('2026-11-20T14:03:00.000Z'), '2026-11-20')
  assert.equal(X.postDate('  last month '), null, 'not a marker this reads')
  assert.equal(X.postDate(''), null)
  for (const [shown, days] of [['1d', 1], ['3d', 3], ['2w', 14], ['5mo', 150], ['1y', 365]] as [string, number][]) {
    const got = X.postDate(shown)
    assert.ok(got && /^\d{4}-\d{2}-\d{2}$/.test(got), `${shown} gives a calendar day`)
    const at = new Date(`${got}T00:00:00Z`).getTime()
    const now = Date.now()
    assert.ok(now - at <= (days + 1) * 86400000 && now - at >= (days - 1) * 86400000, `${shown} is the day it names`)
  }
})

test('a page is read only when it is a signed-in LinkedIn page: a security check or a sign-in prompt is never "0 people"', () => {
  const href = 'https://www.linkedin.com/company/acme/people/'
  assert.equal(X.pageProblem({ href, hasNav: true, hasSignIn: true }), null, 'the signed-in navigation bar decides')
  assert.equal(X.pageProblem({ href, hasNav: false, hasChallenge: true }), 'challenge')
  assert.equal(X.pageProblem({ href, hasNav: false, title: 'Just a moment...' }), 'challenge')
  assert.equal(X.pageProblem({ href, hasNav: false, hasSignIn: true }), 'login_required')
  assert.equal(X.pageProblem({ href, hasNav: false }), 'extract_failed', 'an unrecognised page is a failure, never an empty read')
  assert.equal(X.pageProblem({ href: 'https://www.linkedin.com/checkpoint/challenge/abc', hasNav: true }), 'challenge', 'the address still wins')
})
