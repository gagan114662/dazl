// #1095: a new password sign-up dead-ended on the first-run ready step. Its real GET /api/usage says the trial is
// blocked (google_required), and the ready step read that as "no free searches": it hid Find my first leads and the
// suggestions and showed only the paste-your-key box, with no Link Google anywhere. firstSearchOffer is what the ready
// step offers for that answer; the route legs (real sign-up, session, /api/usage, /api/scan) run in their own process
// (test/helpers/first-search-1095-runtime.mts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { TRIAL_REFUSALS } from '../lib/billing/trial-budget.ts'
import { firstSearchOffer, trialRefusalNotice } from '../lib/trial-copy.ts'
import { scanStartErrorCopy } from '../lib/error-copy.ts'

const RAW = /\b(trial_unavailable|google_required|domain_used|attempts_cap|account_total_cap|global_daily_cap|not_configured|account_cap|ip_throttle|no_api_key)\b/

test('#1095 the real sign-up, /api/usage and /api/scan routes: a new password account is offered Link Google to its first search', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts',
    '--loader', './test/helpers/auth-after-loader.mjs', '--test', './test/helpers/first-search-1095-runtime.mts'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /FIRST SEARCH 1095 ROUTES ok/)
})

test('#1095 the prod /api/usage answer (Hermes-PC, dazl.ai 194e9ada: password account, no key, trial blocked google_required, 3 left) offers Link Google, never key-only', () => {
  const prod = { plan: 'free', scans_used: 0, scan_limit: 50, has_key: false, billing_status: null, trial: { funded: false, remaining: 3, cap: 3, blocked: 'google_required' } }
  const offer = firstSearchOffer(prod)
  assert.equal(offer.kind, 'refused')
  assert.equal(offer.kind === 'refused' && offer.reason, 'google_required')
  assert.ok(trialRefusalNotice('google_required', '/app', { verified: true, google: false, fresh: true }).actions.some(a => a.kind === 'link_google'))
})

test('#1095 every answer /api/usage can give maps to an offer in words: a search to run, or the reason and the way forward', () => {
  assert.deepEqual(firstSearchOffer(null), { kind: 'loading' })
  assert.deepEqual(firstSearchOffer({ has_key: true, trial: null }), { kind: 'own_key', heading: 'Runs on your own AI key' })
  assert.deepEqual(firstSearchOffer({ has_key: false, trial: { funded: true, remaining: 3, cap: 3, blocked: null } }), { kind: 'trial', left: 3, heading: '3 free searches to start' })
  assert.deepEqual(firstSearchOffer({ has_key: false, trial: { funded: true, remaining: 1, cap: 3, blocked: null } }), { kind: 'trial', left: 1, heading: '1 free search to start' })
  // Every trial refusal reason (and the account/network caps, an unknown reason, no trial at all) is a refusal with a
  // notice in words and at least one action; Google-required alone offers Link Google.
  for (const reason of [...TRIAL_REFUSALS, 'account_cap', 'ip_throttle', 'some_new_reason', null]) {
    const o = firstSearchOffer({ has_key: false, trial: { funded: false, remaining: 0, cap: 3, blocked: reason } })
    assert.equal(o.kind, 'refused', String(reason))
    if (o.kind !== 'refused') continue
    assert.doesNotMatch(o.heading, RAW)
    const n = trialRefusalNotice(o.reason, '/app', { verified: true, google: false, fresh: true })
    assert.doesNotMatch(n.text, RAW, String(reason)); assert.ok(n.actions.length >= 1, String(reason))
    assert.equal(n.actions.some(a => a.kind === 'link_google'), reason === 'google_required', String(reason))
  }
  assert.equal(firstSearchOffer({ has_key: false, trial: null }).kind, 'refused', 'a member with no trial of their own: words and the key, never a silent box')
  assert.equal(firstSearchOffer({ has_key: false, trial: { funded: true, remaining: 0, cap: 3, blocked: null } }).kind, 'refused', 'funded with nothing left never claims a free search')
})

test('#1095 the ready step shows the offer\'s notice up front (before any search is run) and its heading', () => {
  const src = readFileSync(new URL('../app/app/first-run.tsx', import.meta.url), 'utf8')
  assert.match(src, /firstSearchOffer\(usage\)/, 'the ready step decides from the /api/usage answer')
  assert.match(src, /data-testid="ready-trial-refusal"/, 'a refused trial shows its notice on the ready step without running a search first')
  assert.match(src, /offer\.heading/, 'the plan card heading comes from the offer (never "Add your AI key to start" when Link Google would start it free)')
})

// Every code POST /api/scan (and the estimate it runs, lib/scan/estimate-request.ts) can answer, read from the route's own
// source, so a new code cannot ship without words. The first search shows scanStartErrorCopy for any refusal that has no
// panel of its own; before this, both start paths printed the code itself (`budget_unknown`, `accounting_unsettled`, ...).
const codesIn = (rel: string) => [...readFileSync(new URL(rel, import.meta.url), 'utf8').matchAll(/error: '([a-z_]+)'/g)].map(m => m[1])
const CODES = [...new Set([...codesIn('../app/api/scan/route.ts'), ...codesIn('../lib/scan/estimate-request.ts')])].sort()

test('#1095 every refusal POST /api/scan can give reads as words on the first search, never the code (with or without its own message)', () => {
  assert.ok(CODES.length >= 25 && CODES.includes('budget_unknown') && CODES.includes('trial_unavailable'), CODES.join(','))
  const SNAKE = /\b[a-z]+_[a-z_]+\b/
  for (const code of [...CODES, 'some_new_code']) {
    for (const j of [{ error: code }, { error: code, message: 'Blocked: your shared spend limit could not be read right now, so what is left of it is unknown. Nothing was started or reserved. Try again in a moment.' }, { error: code, reason: 'google_required' }, { error: code, used: 3, limit: 3 }]) {
      const t = scanStartErrorCopy(j)
      assert.ok(t.length > 15, `${code}: ${t}`)
      assert.doesNotMatch(t, SNAKE, `${code}: no raw code on screen (${t})`)
    }
  }
  // the route's own sentence is kept when it gives one (prod wording of the budget_unknown refusal, lib/scan/price-estimate.ts)
  assert.equal(scanStartErrorCopy({ error: 'budget_unknown', message: 'Blocked: your shared spend limit could not be read right now, so what is left of it is unknown. Nothing was started or reserved. Try again in a moment.' }),
    'Blocked: your shared spend limit could not be read right now, so what is left of it is unknown. Nothing was started or reserved. Try again in a moment.')
  // a "message" that is itself a code is never shown
  assert.doesNotMatch(scanStartErrorCopy({ error: 'x_y', message: 'trial_unavailable' }), SNAKE)
  assert.doesNotMatch(scanStartErrorCopy(null), SNAKE)
})

test('#1095 both first-search start paths fall back to scanStartErrorCopy, never to the raw code', () => {
  for (const f of ['../app/app/first-run.tsx', '../app/app/leads/leads-client.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.match(src, /scanStartErrorCopy\(j\)/, `${f} uses the shared copy`)
    assert.doesNotMatch(src, /: j\.error \|\| '/, `${f}: no fallback prints j.error`)
  }
})
