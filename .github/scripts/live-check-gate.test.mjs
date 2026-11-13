// Tests for the live-check gate (docs/NEVER-AGAIN.md #3). Run: node --test '.github/scripts/*.test.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decide, dryRun, EXAMPLE_SHA, main, passProblem, PASS_RE, REOPEN_BODY } from './live-check-gate.mjs'

const closed = (extra = {}) => ({ number: 1, state: 'closed', state_reason: 'completed', labels: [], ...extra })
const c = (body, author_association = 'OWNER', created_at = '2026-11-13T12:00:00Z') => ({ id: 1, body, author_association, created_at })
const EVIDENCE = 'Signed in on https://dazl.ai as the test account; /api/health reports this commit; Home shows the 30-day tiles and they match Outreach.'
const PASS = `Live check (prod 7f4c9061): PASS\n\n${EVIDENCE}`

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

// Hermes review 3: the "commit" must be a commit. Each of these kept an issue closed before.
test('only a real commit counts: "prod staging", placeholders, branch names and words are rejected', () => {
  for (const b of ['Live check (prod staging): PASS', 'Live check (prod <deployed commit>): PASS', 'Live check (prod <commit>): PASS', 'Live check (prod <sha8>): PASS',
    'Live check (prod main): PASS', 'Live check (prod cc/1040-home-results): PASS', 'Live check (prod latest): PASS', 'Live check (prod 7f4c906): PASS',
    'Live check (prod 7F4C9061): PASS', 'Live check (prod 7f4c9061 staging): PASS', 'Live check (prod  7f4c9061): PASS', 'Live check (prod zzzzzzzz): PASS',
    'Live check (prod 7f4c9061) PASS', 'Live check (staging f6c697d7): PASS', 'Live check (prod staging f6c697d7): PASS'])
    assert.equal(decide(closed(), [c(`${b}\n\n${EVIDENCE}`)]).reopen, true, b)
  for (const sha of ['7f4c9061', '7f4c9069628ad883298f2ac65f8c9ba795976425'])
    assert.equal(decide(closed(), [c(`Live check (prod ${sha}): PASS\n\n${EVIDENCE}`)]).reopen, false, sha)
})

test('quoting the rule is not a check: quoted lines, inline code and code blocks do not count; the line must start a line', () => {
  for (const b of [
    `Rule: close only with a "Live check (prod 7f4c9061): PASS" comment.\n\n${EVIDENCE}`,
    `> Live check (prod 7f4c9061): PASS\n\n${EVIDENCE}`,
    `Post \`Live check (prod 7f4c9061): PASS\` when it is checked.\n\n${EVIDENCE}`,
    `\`\`\`\nLive check (prod 7f4c9061): PASS\n\`\`\`\n\n${EVIDENCE}`,
    `Not yet: Live check (prod 7f4c9061): PASS is still to come.\n\n${EVIDENCE}`,
  ]) assert.equal(decide(closed(), [c(b)]).reopen, true, b)
  for (const b of [`## Live check (prod 7f4c9061): PASS\n${EVIDENCE}`, `**Live check (prod 7f4c9061): PASS**\n${EVIDENCE}`, `- Live check (prod 7f4c9061): PASS\n${EVIDENCE}`, `${EVIDENCE}\n\nLive check (prod 7f4c9061): PASS`])
    assert.equal(decide(closed(), [c(b)]).reopen, false, b)
})

test('a PASS line with no evidence beside it does not count', () => {
  for (const b of ['Live check (prod 7f4c9061): PASS', 'Live check (prod 7f4c9061): PASS\n\nlooks fine', 'Live check (prod 7f4c9061): PASS\n\n> ' + EVIDENCE])
    assert.equal(decide(closed(), [c(b)]).reopen, true, b)
  assert.match(passProblem(c('Live check (prod 7f4c9061): PASS')), /no evidence/)
})

// Independent review R1/R2: text the page shows as code or not at all, a line that goes on after PASS, and the example commit
test('hidden or code text, a PASS line that continues, and the instructions\' own example commit do not count', () => {
  const L = 'Live check (prod 7f4c9061): PASS'
  for (const [name, b] of Object.entries({
    indented4: `    ${L}\n\n${EVIDENCE}`, tab_indented: `\t${L}\n\n${EVIDENCE}`, html_comment: `<!-- ${L} -->\n\n${EVIDENCE}`,
    html_comment_multiline: `<!--\n${L}\n-->\n${EVIDENCE}`, html_comment_unclosed: `${EVIDENCE}\n<!--\n${L}`, unclosed_fence: `${EVIDENCE}\n\`\`\`\n${L}`,
    inline_double_bt: `\`\`${L}\`\`\n\n${EVIDENCE}`, pass_then_fail: `${L} - actually FAIL, still broken\n\n${EVIDENCE}`,
    pass_then_prose: `${L} is the line to post once checked on prod. Staging only so far.\n${EVIDENCE}`,
    zero_width: `Live check (prod 7f4c\u200b9061): PASS\n\n${EVIDENCE}`.replace('7f4c\u200b9061', '7f4c\u200b906'),
    example_sha: `Live check (prod ${EXAMPLE_SHA}): PASS\n\n${EVIDENCE}`, fence4: `\`\`\`\`\n${L}\n\`\`\`\`\n${EVIDENCE}`, tilde: `~~~\n${L}\n~~~\n${EVIDENCE}`,
  })) assert.equal(decide(closed(), [c(b)]).reopen, true, name)
  assert.match(passProblem(c(`Live check (prod ${EXAMPLE_SHA}): PASS\n\n${EVIDENCE}`)), /example/)
  assert.ok(REOPEN_BODY.includes(EXAMPLE_SHA), 'the example the gate shows is the one it refuses')
  for (const b of [`${L}\n\n${EVIDENCE}`, `   ${L}  \n${EVIDENCE}`, `**${L}**\n${EVIDENCE}`, `${L}\r\n\r\n${EVIDENCE}`]) assert.equal(decide(closed(), [c(b)]).reopen, false, b)
})

// Follow-up to the #1153 review (item 3): three more places a reader sees the line as quoted or code. One test per form.
const LINE = 'Live check (prod 7f4c9061): PASS'
test('a line right after a ">" line is still inside the quote (no ">" of its own): does not count', () => {
  for (const b of [`> The rule says:\n${LINE}\n\n${EVIDENCE}`, `> ${EVIDENCE}\n${LINE}\nmore of the quote`, `>quoted\n   ${LINE}\n\n${EVIDENCE}`])
    assert.equal(decide(closed(), [c(b)]).reopen, true, b)
  // a blank line ends the quote: the reply under it is the commenter's own text
  assert.equal(decide(closed(), [c(`> ${EVIDENCE}\n\n${LINE}\n\n${EVIDENCE}`)]).reopen, false)
})

test('the line inside <pre>, <code> or <blockquote> does not count, closed or not', () => {
  for (const b of [`<pre>\n${LINE}\n</pre>\n\n${EVIDENCE}`, `<pre lang="text">\n${LINE}\n</pre>\n${EVIDENCE}`, `${EVIDENCE}\n<pre>\n${LINE}`, `<PRE>\n${LINE}\n</PRE>\n${EVIDENCE}`,
    `<code>\n${LINE}\n</code>\n${EVIDENCE}`, `<blockquote>\n${LINE}\n</blockquote>\n${EVIDENCE}`])
    assert.equal(decide(closed(), [c(b)]).reopen, true, b)
  assert.equal(decide(closed(), [c(`<pre>\nsome log\n</pre>\n\n${LINE}\n\n${EVIDENCE}`)]).reopen, false, 'a log in <pre> beside a real line is fine')
})

// Removing the inline-code strip from ownText makes this test fail (the mutation that survived the #1153 review).
test('the line inside inline code that spans lines does not count', () => {
  for (const b of [`Post this when checked: \`\n${LINE}\n\`\n\n${EVIDENCE}`, `\`\`\n${LINE}\n\`\`\n${EVIDENCE}`, `${EVIDENCE} \`the line is\n${LINE}\nexactly\``])
    assert.equal(decide(closed(), [c(b)]).reopen, true, b)
  // inline code elsewhere in a real check does not hide the line or the evidence
  assert.equal(decide(closed(), [c(`${LINE}\n\n\`GET /api/health\` reports this commit. ${EVIDENCE}`)]).reopen, false)
  assert.equal(decide(closed(), [c(`${LINE}\n\nran \`a\` and \`b\`.\n${EVIDENCE}`)]).reopen, false)
})

// Hermes review 4
test('a PASS from before the last reopen does not count; one after it does', () => {
  const early = c(PASS, 'OWNER', '2026-11-10T10:00:00Z'), late = c(PASS, 'OWNER', '2026-11-12T10:00:00Z')
  assert.equal(decide(closed(), [early], '2026-11-11T09:00:00Z').reopen, true, 'the only PASS predates the reopen')
  assert.match(decide(closed(), [early], '2026-11-11T09:00:00Z').reason, /before the issue was last reopened/)
  assert.equal(decide(closed(), [early, late], '2026-11-11T09:00:00Z').reopen, false)
  assert.equal(decide(closed(), [early], null).reopen, false, 'never reopened')
  assert.equal(decide(closed(), [{ ...early, created_at: undefined }], '2026-11-11T09:00:00Z').reopen, true, 'no date: not after the reopen')
})

test('the workflow runs this gate on issues: closed with issues: write only', () => {
  const wf = readFileSync(new URL('../workflows/live-check-gate.yml', import.meta.url), 'utf8')
  assert.match(wf, /issues:\s*\n\s*types:\s*\[closed\]/)
  assert.match(wf, /issues: write/)
  assert.doesNotMatch(wf, /contents: write|pull-requests: write/)
  assert.match(wf, /node \.github\/scripts\/live-check-gate\.mjs/)
})

// A mocked REST API: the current issue, paginated comments, events. Returns the calls made.
async function runMain({ event = {}, current = {}, page2 = [], events = [], fail = {} } = {}) {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/lcg-`)
  const api = 'https://api.github.test/repos/o/r/issues/7'
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method} ${url}${init.body ? ' ' + init.body : ''}`)
    const key = `${init.method} ${url.replace(api, '')}`
    for (const [k, status] of Object.entries(fail)) if (k.endsWith('$') ? key === k.slice(0, -1) : key.startsWith(k)) return new Response('boom', { status })
    if (init.method !== 'GET') return new Response('{}', { status: 200 })
    if (url === api) return new Response(JSON.stringify({ ...closed({ number: 7 }), ...current }), { status: 200 })
    if (url === `${api}/events?per_page=100`) return new Response(JSON.stringify(events), { status: 200 })
    const json = url.endsWith('comments?per_page=100') ? [c('first page, no proof')] : url.endsWith('page=2') ? page2 : []
    const link = url.endsWith('comments?per_page=100') ? `<${api}/comments?per_page=100&page=2>; rel="next"` : ''
    return new Response(JSON.stringify(json), { status: 200, headers: { link } })
  }
  const ev = `${dir}/event.json`
  writeFileSync(ev, JSON.stringify({ issue: { ...closed({ number: 7 }), url: api, comments_url: `${api}/comments`, ...event } }))
  process.env.GITHUB_EVENT_PATH = ev; process.env.GITHUB_TOKEN = 't'
  try { await main() } finally { globalThis.fetch = realFetch }
  return { calls, api, writes: calls.filter(x => !x.startsWith('GET')) }
}

test('end to end: main() reopens over the REST API (reopen first, then the comment), paginating comments; leaves a passed issue alone', async () => {
  const r = await runMain({ page2: [c('still nothing')] })
  assert.equal(r.writes.length, 2, r.calls.join('\n'))
  assert.equal(r.writes[0], `PATCH ${r.api} {"state":"open"}`, 'the reopen comes first')
  assert.match(r.writes[1], /^POST .*\/issues\/7\/comments .*Reopened by the live-check gate/)
  assert.ok(r.calls.some(x => x.endsWith('page=2')), 'every page of comments is read')
  const kept = await runMain({ page2: [c(PASS)] })
  assert.deepEqual(kept.writes, [], kept.calls.join('\n'))
})

// Hermes review 5
test('end to end: the issue is reopened even when the explanatory comment cannot be posted', async () => {
  const r = await runMain({ fail: { 'POST /comments': 500 } })
  assert.deepEqual(r.writes.map(x => x.split(' ').slice(0, 2).join(' ')), [`PATCH ${r.api}`, `POST ${r.api}/comments`])
})

test('end to end: the decision uses the issue as it is now, not the event snapshot', async () => {
  // re-closed as not planned (or relabelled, or already open) since the event was queued: left alone
  for (const current of [{ state_reason: 'not_planned' }, { labels: [{ name: 'wontfix' }] }, { state: 'open', state_reason: null }])
    assert.deepEqual((await runMain({ current })).writes, [], JSON.stringify(current))
  // the snapshot said not planned, but the issue is now closed as completed with no proof: reopened
  assert.equal((await runMain({ event: { state_reason: 'not_planned' } })).writes.length, 2)
})

test('end to end: a PASS that predates the last reopened event does not keep it closed', async () => {
  const early = c(PASS, 'OWNER', '2026-11-10T10:00:00Z')
  const events = [{ event: 'closed', created_at: '2026-11-10T11:00:00Z' }, { event: 'reopened', created_at: '2026-11-11T09:00:00Z' }, { event: 'closed', created_at: '2026-11-12T09:00:00Z' }]
  assert.equal((await runMain({ page2: [early], events })).writes.length, 2)
  assert.deepEqual((await runMain({ page2: [early], events: [events[0]] })).writes, [], 'never reopened: the PASS stands')
  assert.deepEqual((await runMain({ page2: [early, c(PASS, 'OWNER', '2026-11-12T08:00:00Z')], events })).writes, [])
})

test('end to end: comments or events that cannot be read are decided as no proof (reopen), never left closed', async () => {
  assert.equal((await runMain({ page2: [c(PASS)], fail: { 'GET /events': 502 } })).writes[0].startsWith('PATCH'), true)
  assert.equal((await runMain({ fail: { 'GET /comments': 502 } })).writes[0].startsWith('PATCH'), true)
  assert.deepEqual((await runMain({ current: { state_reason: 'duplicate' }, fail: { 'GET /comments': 502 } })).writes, [])
  assert.deepEqual((await runMain({ current: { labels: [{ name: 'wontfix' }] }, fail: { 'GET /events': 502 } })).writes, [], 'an exempt label is still exempt')
  // independent review R3: the issue itself cannot be read -> the event's own copy decides: closed as completed, so reopen
  const r = await runMain({ page2: [c(PASS)], fail: { 'GET $': 502 } })
  assert.equal(r.writes[0], `PATCH ${r.api} {"state":"open"}`)
  assert.deepEqual((await runMain({ event: { state_reason: 'not_planned' }, fail: { 'GET $': 502 } })).writes, [], 'the event says not planned: left closed')
})

test('the dry run reports and changes nothing', async () => {
  const realFetch = globalThis.fetch; const calls = [], lines = []
  process.env.GITHUB_REPOSITORY = 'o/r'; process.env.GITHUB_API_URL = 'https://api.github.test'
  globalThis.fetch = async (url, init = {}) => { calls.push(init.method)
    return new Response(JSON.stringify(/\/issues\/\d+$/.test(url) ? closed({ number: 7 }) : url.includes('/comments') && url.includes('/8/') ? [c(PASS)] : []), { status: 200 }) }
  try { await dryRun(['7', '8'], l => lines.push(l)) } finally { globalThis.fetch = realFetch; delete process.env.GITHUB_API_URL }
  assert.ok(calls.every(m => m === 'GET'))
  assert.match(lines[0], /^#7 \[closed\/completed\]: WOULD REOPEN/); assert.match(lines[1], /^#8 \[closed\/completed\]: stays closed/)
})
