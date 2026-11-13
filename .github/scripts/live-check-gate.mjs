// NEVER-AGAIN #3 (docs/NEVER-AGAIN.md): an issue closes only with a live check on prod.
// Issues were closed on staging-only proof (#914 #915 #846 #847). .github/workflows/live-check-gate.yml runs this on every
// `issues: closed` event: unless the issue was closed as not planned / duplicate (or carries a wontfix, duplicate or
// not-planned label), it must have a comment from a repo owner/member/collaborator, posted after the issue was last
// reopened, with a line "Live check (prod <8-40 hex commit>): PASS" and the evidence beside it. Otherwise the issue is
// reopened (first), with a comment saying why.
// Tested by .github/scripts/live-check-gate.test.mjs (never-again-gates.yml runs it on every pull request).

// The line must be exactly "Live check (prod <commit>): PASS" with a real commit: 8 to 40 hex characters (the deployed
// commit from https://dazl.ai/api/health). "prod staging", a placeholder (<sha8>, <commit>), a branch name or a word is not
// a commit. It must start a line of the comment's own text (a heading, list or bold marker may precede it): the same words
// inside a quote (">"), inline code or a code block are someone citing the rule, not a check.
export const PASS_RE = /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+)?(?:\*\*|__)?Live check \(prod ([0-9a-f]{8,40})\): PASS\b/m
export const MIN_EVIDENCE = 80   // characters of the comment besides the PASS line: what was checked on dazl.ai and what it showed
export const EXEMPT_REASONS = new Set(['not_planned', 'duplicate'])
export const EXEMPT_LABELS = new Set(['wontfix', 'duplicate', 'not-planned', 'not planned'])
export const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// The comment's own text: fenced code blocks, inline code and quoted lines removed.
const ownText = body => body.replace(/\r/g, '').replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '').split('\n').filter(l => !/^[ \t]*>/.test(l)).join('\n')

// null, or why the comment is not a prod live check PASS. Exported for the tests and the dry run.
export function passProblem(c, after = null) {
  if (typeof c?.body !== 'string') return 'no text'
  if (!TRUSTED.has(c.author_association)) return 'not from a maintainer'
  const text = ownText(c.body)
  const m = PASS_RE.exec(text)
  if (!m) return 'no line "Live check (prod <8-40 hex commit>): PASS"'
  const rest = text.replace(PASS_RE, '').replace(/\s+/g, ' ').trim()
  if (rest.length < MIN_EVIDENCE) return `no evidence beside the PASS line (${rest.length} of ${MIN_EVIDENCE} characters)`
  if (after !== null && !(Date.parse(c.created_at) > Date.parse(after))) return `posted before the issue was last reopened (${after})`
  return null
}

// issue: the CURRENT issue object; comments: every comment on it (all pages); lastReopenedAt: created_at of its most recent
// `reopened` event, or null. A PASS counts only when posted after that: a check of commit A does not cover a regression
// the issue was reopened for. Returns { reopen, reason }.
export function decide(issue, comments, lastReopenedAt = null) {
  if (!issue || issue.pull_request) return { reopen: false, reason: 'not an issue' }
  if (issue.state !== 'closed') return { reopen: false, reason: 'not closed' }
  if (EXEMPT_REASONS.has(issue.state_reason)) return { reopen: false, reason: `closed as ${issue.state_reason}` }
  const labels = (issue.labels || []).map(l => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())
  const lab = labels.find(l => EXEMPT_LABELS.has(l))
  if (lab) return { reopen: false, reason: `labelled ${lab}` }
  const list = Array.isArray(comments) ? comments : []
  const pass = list.find(c => passProblem(c, lastReopenedAt) === null)
  if (pass) return { reopen: false, reason: `live check comment ${pass.html_url || pass.id}` }
  // the nearest miss, so the reopen says what was wrong with it
  const near = list.map(c => ({ c, why: passProblem(c, lastReopenedAt) })).filter(x => /Live check/i.test(String(x.c?.body ?? '')) && TRUSTED.has(x.c?.author_association)).pop()
  return { reopen: true, reason: `no valid "Live check (prod <commit>): PASS" comment from a maintainer${near ? ` (latest live-check comment: ${near.why})` : ''}` }
}

export const REOPEN_BODY = [
  'Reopened by the live-check gate (docs/NEVER-AGAIN.md #3, `.github/workflows/live-check-gate.yml`).',
  '',
  'An issue closes only after the fix is deployed to production and checked there. Post a new comment that has, on a',
  'line of its own, `Live check (prod 1a2b3c4d): PASS` - with the deployed commit from https://dazl.ai/api/health (8 to 40',
  'hex characters) in place of 1a2b3c4d - and says what was checked on dazl.ai and what it showed. Then close it again.',
  'A check posted before the issue was last reopened does not count. Closing as "not planned" or "duplicate" (or',
  'labelling it wontfix / duplicate / not-planned) is exempt.',
].join('\n')

async function gh(token, method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`)
  return r
}

async function allPages(token, url) {
  const out = []
  for (let next = `${url}?per_page=100`; next;) {
    const r = await gh(token, 'GET', next)
    out.push(...await r.json())
    next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '')?.[1]
  }
  return out
}

// The current issue, its comments and its last reopen, decided. Anything that cannot be read is decided as "no proof"
// (reopen): the gate fails toward open, never toward a close nobody checked.
async function check(token, issueUrl) {
  const issue = await (await gh(token, 'GET', issueUrl)).json()
  let comments = [], reopenedAt = null, unread = null
  try {
    comments = await allPages(token, `${issueUrl}/comments`)
    reopenedAt = (await allPages(token, `${issueUrl}/events`)).filter(e => e?.event === 'reopened').map(e => e.created_at).sort().pop() ?? null
  } catch (e) { unread = String(e?.message ?? e).slice(0, 200) }
  const d = unread && issue.state === 'closed' && !issue.pull_request && !EXEMPT_REASONS.has(issue.state_reason)
    ? { reopen: true, reason: `the comments or events could not be read (${unread})` } : decide(issue, comments, reopenedAt)
  return { issue, ...d }
}

export async function main() {
  const { readFileSync } = await import('node:fs')
  const token = process.env.GITHUB_TOKEN
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  // decided on the issue as it is NOW (state, reason, labels), not the event's snapshot: a queued run must not reopen an
  // issue since re-closed as not planned
  const { issue, reopen, reason } = await check(token, event.issue.url)
  console.log(`#${issue.number}: ${reopen ? 'REOPEN' : 'ok'} (${reason})`)
  if (!reopen) return
  // reopen FIRST: the explanation is not a precondition (a failed comment is logged, the issue is still open again)
  await gh(token, 'PATCH', event.issue.url, { state: 'open' })
  try { await gh(token, 'POST', `${event.issue.url}/comments`, { body: `${REOPEN_BODY}\n\nWhy: ${reason}.` }) }
  catch (e) { console.log(`::warning::#${issue.number} reopened, but the explanation could not be posted: ${String(e?.message ?? e).slice(0, 200)}`) }
  console.log(`::warning::#${issue.number} reopened: ${reason}`)
}

// Dry run (changes nothing): node .github/scripts/live-check-gate.mjs --dry-run 1042 1040 ...
// Needs GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo). Prints what the gate would do with each issue as it stands.
export async function dryRun(numbers, log = console.log) {
  const token = process.env.GITHUB_TOKEN, api = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}`
  for (const n of numbers) {
    const { issue, reopen, reason } = await check(token, `${api}/issues/${n}`)
    log(`#${n} [${issue.state}${issue.state_reason ? '/' + issue.state_reason : ''}]: ${issue.state !== 'closed' ? 'n/a' : reopen ? 'WOULD REOPEN' : 'stays closed'} (${reason})`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--dry-run')
  ;(i > 0 ? dryRun(process.argv.slice(i + 1)) : main()).catch(e => { console.error(e); process.exit(1) })
}
