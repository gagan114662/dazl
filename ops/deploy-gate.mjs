#!/usr/bin/env node
// Deploy gate (issue #362; web/docs/DEPLOY.md "Deploy gate"). A commit may be deployed only when, on THAT exact commit:
//   - it is on main (main is it, or contains it), and
//   - every required check run, posted by GitHub Actions itself, completed with conclusion "success":
//       test-sqlite, test-postgres   web-ci: typecheck and the full suite on both stores
//       browser                      release-gate: production build plus every production smoke check
//       migrations                   release-gate: migration content gate and previous-release start (rollback)
// Pending, missing, skipped, neutral, cancelled, timed-out or failed is not a pass. A check of the same name from any
// other GitHub App, or for another commit, does not count. When a check was re-run, the newest run decides. A check
// still missing DEPLOY_GATE_MISSING_AFTER_S (3600) after the commit was made is blocked, not pending: its run is not
// coming (e.g. the commit touched no gated path), so there is no evidence for that commit.
//   node ops/deploy-gate.mjs <full sha> [--repo owner/name] [--branch main] [--require a,b,c] [--report FILE]
// Prints one JSON line. Exit 0 allowed; 1 blocked (a check failed, or the commit is not on the branch); 3 pending (wait
// and ask again); 2 usage or the API could not be read (never treated as allowed).
// --report FILE also writes that JSON (mode 600): ops/safe_launch.py requires an allowed report for the commit it
// launches, and ops/staging/deploy.sh runs this gate before building.
// GitHub API: DEPLOY_GATE_API (default https://api.github.com; http only for 127.0.0.1/localhost, for tests).
// DEPLOY_GATE_GITHUB_TOKEN: needed only while the repository is private: a fine-grained, read-only token for this one
// repository with "Checks: read" and "Contents: read" (free). It is sent only to DEPLOY_GATE_API and never printed.
import { writeFileSync } from 'node:fs'

export const REQUIRED = ['test-sqlite', 'test-postgres', 'browser', 'migrations']
export const ACTIONS_APP = 'github-actions'

// Pure decision over the API's answers, so it can be tested without a network.
export function decide({ sha, onBranch, runs, required = REQUIRED, commitAgeS = 0, missingAfterS = 3600 }) {
  const checks = {}
  const reasons = []
  for (const name of required) {
    const mine = runs.filter(r => r.name === name && r.head_sha === sha && r.app?.slug === ACTIONS_APP)
      .sort((a, b) => Date.parse(b.started_at ?? 0) - Date.parse(a.started_at ?? 0) || b.id - a.id)
    const r = mine[0]
    const state = !r ? (commitAgeS > missingAfterS ? 'never_ran' : 'missing') : r.status !== 'completed' ? 'pending' : r.conclusion ?? 'unknown'
    checks[name] = state
    if (state !== 'success') reasons.push(`${name}: ${state}`)
  }
  const foreign = runs.filter(r => required.includes(r.name) && r.app?.slug !== ACTIONS_APP).map(r => `${r.name} from ${r.app?.slug ?? 'unknown app'}`)
  if (!onBranch.ok) reasons.unshift(`commit is not on ${onBranch.branch} (${onBranch.status})`)
  const states = Object.values(checks)
  const failed = !onBranch.ok || states.some(s => !['success', 'pending', 'missing'].includes(s))
  // missing (no run yet: CI is queued) and pending (running) wait; everything else that is not success blocks
  const decision = failed ? 'blocked' : states.every(s => s === 'success') ? 'allowed' : 'pending'
  return { decision, checks, reasons, ignored_foreign_checks: foreign }
}

async function main() {
  const argv = process.argv.slice(2)
  const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
  const sha = argv[0]
  const out = (o, code) => { const line = JSON.stringify({ tool: 'dazl-deploy-gate', ...o }); console.log(line); const f = opt('--report'); if (f) writeFileSync(f, line + '\n', { mode: 0o600 }); process.exit(code) }
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) out({ ok: false, decision: 'error', error: 'usage: deploy-gate.mjs <40-hex commit sha> [--repo o/r] [--branch main] [--require a,b] [--report FILE]' }, 2)
  const repo = opt('--repo') ?? 'gagan114662/dazl', branch = opt('--branch') ?? 'main'
  const required = opt('--require')?.split(',').map(s => s.trim()).filter(Boolean) ?? REQUIRED
  const api = (process.env.DEPLOY_GATE_API ?? 'https://api.github.com').replace(/\/+$/, '')
  const u = new URL(api)
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) out({ ok: false, decision: 'error', commit: sha, error: 'DEPLOY_GATE_API must be https' }, 2)
  const token = process.env.DEPLOY_GATE_GITHUB_TOKEN
  const get = async p => {
    const r = await fetch(api + p, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`GET ${p.split('?')[0]} -> HTTP ${r.status}`)
    return r.json()
  }
  const base = { repo, branch, commit: sha, required, checked_at: new Date().toISOString() }
  try {
    // ahead/diverged: the commit is not contained in the branch; identical/behind: it is (the branch is it or past it)
    const cmp = await get(`/repos/${repo}/compare/${encodeURIComponent(branch)}...${sha}`)
    const onBranch = { ok: cmp.status === 'identical' || cmp.status === 'behind', status: cmp.status, branch }
    const commit = await get(`/repos/${repo}/commits/${sha}`)
    const made = Date.parse(commit.commit?.committer?.date ?? '')
    const commitAgeS = Number.isNaN(made) ? Infinity : (Date.now() - made) / 1000
    const runs = []
    for (let page = 1; page <= 10; page++) {
      const j = await get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`)
      runs.push(...(j.check_runs ?? []))
      if (runs.length >= (j.total_count ?? 0) || !(j.check_runs ?? []).length) break
    }
    const d = decide({ sha, onBranch, runs, required, commitAgeS, missingAfterS: Number(process.env.DEPLOY_GATE_MISSING_AFTER_S ?? 3600) })
    out({ ok: d.decision === 'allowed', ...base, ...d }, d.decision === 'allowed' ? 0 : d.decision === 'pending' ? 3 : 1)
  } catch (e) {
    out({ ok: false, decision: 'error', ...base, error: e instanceof Error ? e.message : 'error' }, 2)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
