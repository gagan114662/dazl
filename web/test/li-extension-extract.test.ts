// #1122: the dazl LinkedIn Reader's page reading, run on invented card records (unit only: not proof of LinkedIn's live markup,
// which is checked by the user loading the extension). Also pins the manifest to read-only permissions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const dir = fileURLToPath(new URL('../../extension/', import.meta.url))
type Extract = { people: (r: unknown[]) => unknown[]; blockedReason: (h: string) => string | null; pageProblem: (p: Record<string, unknown>) => string | null }
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

test('a page is read only when it is a signed-in LinkedIn page: a security check or a sign-in prompt is never "0 people"', () => {
  const href = 'https://www.linkedin.com/company/acme/people/'
  assert.equal(X.pageProblem({ href, hasNav: true, hasSignIn: true }), null, 'the signed-in navigation bar decides')
  assert.equal(X.pageProblem({ href, hasNav: false, hasChallenge: true }), 'challenge')
  assert.equal(X.pageProblem({ href, hasNav: false, title: 'Just a moment...' }), 'challenge')
  assert.equal(X.pageProblem({ href, hasNav: false, hasSignIn: true }), 'login_required')
  assert.equal(X.pageProblem({ href, hasNav: false }), 'extract_failed', 'an unrecognised page is a failure, never an empty read')
  assert.equal(X.pageProblem({ href: 'https://www.linkedin.com/checkpoint/challenge/abc', hasNav: true }), 'challenge', 'the address still wins')
})
