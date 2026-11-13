// Tests for the live-check gate (docs/NEVER-AGAIN.md #3). Run: node --test '.github/scripts/*.test.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decide, main, PASS_RE } from './live-check-gate.mjs'

const closed = (extra = {}) => ({ number: 1, state: 'closed', state_reason: 'completed', labels: [], ...extra })
const c = (body, author_association = 'OWNER') => ({ id: 1, body, author_association })
const PASS = 'Live check (prod 7f4c9061): PASS - signed in on dazl.ai, Home shows the 30-day tiles'

test('closed as completed with no comment is reopened', () => {
  assert.equal(decide(closed(), []).reopen, true)
})

test('staging-only proof is not enough (#914 #915 #846 #847)', () => {
  for (const b of ['Live check (staging 7f4c9061): PASS', 'verified on staging, closing', 'Live check (prod 7f4c9061): FAIL', 'live check (prod abc): pass', 'Live check prod 7f4c9061: PASS'])
    assert.equal(decide(closed(), [c(b)]).reopen, true, b)
})

test('a maintainer comment with "Live check (prod <commit>): PASS" keeps it closed', () => {
  for (const who of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(decide(closed(), [c('x'), c(PASS, who)]).reopen, false, who)
  assert.equal(decide(closed(), [c(`Evidence:\n\n${PASS}\n\nscreens attached`)]).reopen, false)
})

test('the same text from a non-maintainer does not count', () => {
  for (const who of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR']) assert.equal(decide(closed(), [c(PASS, who)]).reopen, true, who)
  assert.equal(decide(closed(), [{ id: 2, body: PASS }]).reopen, true, 'no author_association')
})

test('not planned / duplicate closes and exempt labels are left closed', () => {
  assert.equal(decide(closed({ state_reason: 'not_planned' }), []).reopen, false)
  assert.equal(decide(closed({ state_reason: 'duplicate' }), []).reopen, false)
  for (const name of ['wontfix', 'duplicate', 'not-planned', 'Not-Planned'])
    assert.equal(decide(closed({ labels: [{ name: 'p1' }, { name }] }), []).reopen, false, name)
  assert.equal(decide(closed({ labels: [{ name: 'needs-live-check' }] }), []).reopen, true)
})

test('odd input fails toward reopening, never throws', () => {
  for (const comments of [null, undefined, [null], [{ body: null }], [{ body: 42, author_association: 'OWNER' }]])
    assert.equal(decide(closed(), comments).reopen, true)
  assert.equal(decide(closed({ labels: null, state_reason: null }), []).reopen, true)
  assert.equal(decide(closed({ labels: ['wontfix'] }), []).reopen, false)
  assert.equal(decide({ state: 'open' }, []).reopen, false)
  assert.equal(decide({ state: 'closed', pull_request: {} }, []).reopen, false)
})

test('the pattern needs a commit inside the parentheses', () => {
  assert.ok(PASS_RE.test('Live check (prod 7f4c9061): PASS'))
  assert.ok(!PASS_RE.test('Live check (prod ): PASS'))
  assert.ok(!PASS_RE.test('Live check (prod 7f4c9061): PASSED'))
})

test('the workflow runs this gate on issues: closed with issues: write only', () => {
  const wf = readFileSync(new URL('../workflows/live-check-gate.yml', import.meta.url), 'utf8')
  assert.match(wf, /issues:\s*\n\s*types:\s*\[closed\]/)
  assert.match(wf, /issues: write/)
  assert.doesNotMatch(wf, /contents: write|pull-requests: write/)
  assert.match(wf, /node \.github\/scripts\/live-check-gate\.mjs/)
})

test('end to end: main() reopens over the REST API, paginating comments; leaves a passed issue alone', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/lcg-`)
  const api = 'https://api.github.test/repos/o/r/issues/7'
  const realFetch = globalThis.fetch
  const run = async (page2) => {
    const calls = []
    globalThis.fetch = async (url, init = {}) => {
      calls.push(`${init.method} ${url}${init.body ? ' ' + init.body : ''}`)
      const json = url.endsWith('?per_page=100') ? [c('first page, no proof')] : url.endsWith('page=2') ? page2 : {}
      const link = url.endsWith('?per_page=100') ? `<${api}/comments?per_page=100&page=2>; rel="next"` : ''
      return new Response(JSON.stringify(json), { status: 200, headers: { link } })
    }
    const ev = `${dir}/event.json`
    writeFileSync(ev, JSON.stringify({ issue: { ...closed({ number: 7 }), url: api, comments_url: `${api}/comments` } }))
    process.env.GITHUB_EVENT_PATH = ev; process.env.GITHUB_TOKEN = 't'
    try { await main() } finally { globalThis.fetch = realFetch }
    return calls
  }
  const reopened = await run([c('still nothing')])
  assert.equal(reopened.length, 4)
  assert.match(reopened[2], /^POST .*\/issues\/7\/comments .*Reopened by the live-check gate/)
  assert.equal(reopened[3], `PATCH ${api} {"state":"open"}`)
  const kept = await run([c(PASS)])
  assert.equal(kept.length, 2, kept.join('\n'))
  assert.ok(kept.every(x => x.startsWith('GET')))
})
