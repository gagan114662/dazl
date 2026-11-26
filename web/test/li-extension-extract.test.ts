// #1122: the dazl LinkedIn Reader's page reading, run on invented card records (unit only: not proof of LinkedIn's live markup,
// which is checked by the user loading the extension). Also pins the manifest to read-only permissions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const dir = fileURLToPath(new URL('../../extension/', import.meta.url))
type Extract = { people: (r: unknown[]) => unknown[]; postEngagers: (r: unknown[]) => Record<string, unknown>[]; companyPosts: (r: unknown[]) => { url: string; date: string | null; approx: boolean; author: string }[]; postUrl: (h: string) => string | null; postDate: (s: string) => string | null; postDateExact: (s: string) => boolean; pageUrl: (h: string) => string | null; blockedReason: (h: string) => string | null; pageProblem: (p: Record<string, unknown>) => string | null }
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

test('#1588 companyPosts: the page\u2019s own post links, once each, with their author, and the date as shown or none', () => {
  const ACME = 'https://www.linkedin.com/company/acme/'
  const got = X.companyPosts([
    { href: '/posts/acme_sales-activity-7212345678901234567-AbCd?trk=x', date: '2026-11-20T14:03:00.000Z', author: '/company/acme/?trk=feed' },
    { href: 'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234567-AbCd/', date: '3w', author: ACME },
    { href: '/feed/update/urn:li:activity:7212345678901234569/', date: '2d', author: 'https://www.linkedin.com/in/acme-founder/' },
    { href: '/posts/acme_sales-activity-7212345678901234571-Re/', date: '2026-11-21', author: 'https://www.linkedin.com/company/someone-else/' },  // another author's post
    { href: '/posts/acme_sales-activity-7212345678901234572-No/', date: '2026-11-21' },                               // author not named on the page
    { href: '/company/acme/', date: '2026-11-20', author: ACME },                                                      // a company link is not a post
    { href: '/posts/acme_sales-activity-7212345678901234570-Zz/', date: '', author: ACME },                            // no date shown: kept, undated
    { href: 'https://news.example/x', date: '2026-11-20', author: ACME },                                              // not LinkedIn
  ])
  const urls = JSON.parse(JSON.stringify(got.map(p => p.url))) as string[]
  assert.deepEqual(urls, [
    'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234567-AbCd/',
    'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234569/',
    'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234571-Re/',
    'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234570-Zz/',
  ])
  assert.equal(got.length, 4, 'the duplicate post link is read once; non-posts and posts whose author the page did not name are never read')
  assert.deepEqual(JSON.parse(JSON.stringify(got[0])), { url: 'https://www.linkedin.com/posts/acme_sales-activity-7212345678901234567-AbCd/', date: '2026-11-20', approx: false, author: ACME }, 'a full timestamp is its exact calendar day')
  assert.equal(got[0].author, ACME, 'the author link is normalized to the page shape')
  assert.equal(got[2].author, 'https://www.linkedin.com/company/someone-else/', 'another page\u2019s post keeps its author, so the server can drop it')
  assert.equal(got[1].approx, true, 'a relative age marks the day approximate')
  assert.equal(got[3].date, null, 'no date on the page is no date, never invented')
  assert.equal(got[3].approx, false)
})

test('#1588 postDate: what the page shows, resolved to its OLDEST plausible day, or nothing', () => {
  assert.equal(X.postDate('2026-11-20T14:03:00.000Z'), '2026-11-20')
  assert.equal(X.postDate('  last month '), null, 'not a marker this reads')
  assert.equal(X.postDate(''), null)
  const daysAgo = (s: string | null) => s ? (Date.now() - new Date(`${s}T00:00:00Z`).getTime()) / 86400000 : -1
  // A marker names a range (2w = 14-20 days ago), so the day is the oldest it could mean: never newer than the truth.
  for (const [shown, oldest, newest] of [['1d', 1, 2], ['2d', 2, 3], ['3h', 1, 1], ['45m', 1, 1], ['2w', 14, 20], ['1mo', 30, 59], ['1y', 365, 729]] as [string, number, number][]) {
    const got = X.postDate(shown)
    assert.ok(got && /^\d{4}-\d{2}-\d{2}$/.test(got), `${shown} gives a calendar day`)
    const age = daysAgo(got)
    assert.ok(age >= oldest - 1 && age <= newest + 1, `${shown} resolves inside ${oldest}-${newest} days, got ${Math.round(age)}`)
  }
  assert.equal(X.postDate('1mo') != null && daysAgo(X.postDate('1mo')) >= 29, true, 'a "1mo" post is never read as under 30 days')
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
