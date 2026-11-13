// NEVER-AGAIN #3 (docs/NEVER-AGAIN.md): an issue closes only with a live check on prod.
// Issues were closed on staging-only proof (#914 #915 #846 #847). .github/workflows/live-check-gate.yml runs this on every
// `issues: closed` event: unless the issue was closed as not planned / duplicate (or carries a wontfix, duplicate or
// not-planned label), it must have a comment from a repo owner/member/collaborator containing
// "Live check (prod <commit>): PASS". Otherwise the issue is reopened with a comment saying why.
// Tested by .github/scripts/live-check-gate.test.mjs (never-again-gates.yml runs it on every pull request).

export const PASS_RE = /Live check \(prod [^)\r\n]+\): PASS\b/
export const EXEMPT_REASONS = new Set(['not_planned', 'duplicate'])
export const EXEMPT_LABELS = new Set(['wontfix', 'duplicate', 'not-planned', 'not planned'])
export const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// issue: the event's issue object; comments: every comment on it (all pages). Returns { reopen, reason }.
export function decide(issue, comments) {
  if (!issue || issue.pull_request) return { reopen: false, reason: 'not an issue' }
  if (issue.state !== 'closed') return { reopen: false, reason: 'not closed' }
  if (EXEMPT_REASONS.has(issue.state_reason)) return { reopen: false, reason: `closed as ${issue.state_reason}` }
  const labels = (issue.labels || []).map(l => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())
  const lab = labels.find(l => EXEMPT_LABELS.has(l))
  if (lab) return { reopen: false, reason: `labelled ${lab}` }
  const pass = (comments || []).find(c => typeof c?.body === 'string' && PASS_RE.test(c.body) && TRUSTED.has(c.author_association))
  if (pass) return { reopen: false, reason: `live check comment ${pass.html_url || pass.id}` }
  return { reopen: true, reason: 'no "Live check (prod <commit>): PASS" comment from a maintainer' }
}

export const REOPEN_BODY = [
  'Reopened by the live-check gate (docs/NEVER-AGAIN.md #3, `.github/workflows/live-check-gate.yml`).',
  '',
  'An issue closes only after the fix is deployed to production and checked there. Post the evidence as a comment',
  'containing `Live check (prod <deployed commit>): PASS` (what was checked on dazl.ai and what it showed), then close',
  'it again. Closing as "not planned" or "duplicate" (or labelling it wontfix / duplicate / not-planned) is exempt.',
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

async function allComments(token, url) {
  const out = []
  for (let next = `${url}?per_page=100`; next;) {
    const r = await gh(token, 'GET', next)
    out.push(...await r.json())
    next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '')?.[1]
  }
  return out
}

export async function main() {
  const { readFileSync } = await import('node:fs')
  const token = process.env.GITHUB_TOKEN
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const issue = event.issue
  const comments = await allComments(token, issue.comments_url)
  const { reopen, reason } = decide(issue, comments)
  console.log(`#${issue.number}: ${reopen ? 'REOPEN' : 'ok'} (${reason})`)
  if (!reopen) return
  await gh(token, 'POST', issue.comments_url, { body: REOPEN_BODY })
  await gh(token, 'PATCH', issue.url, { state: 'open' })
  console.log(`::warning::#${issue.number} reopened: ${reason}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1) })
}
