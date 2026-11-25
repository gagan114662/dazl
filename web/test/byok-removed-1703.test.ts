import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { ACCOUNT_LOAD_FAILED, TRIAL_REFUSAL_COPY, trialCopy, trialRefusalNotice, trialRefusedCopy, signUpPlanLine } from '../lib/trial-copy.ts'
import { TRIAL_REFUSALS } from '../lib/billing/trial-budget.ts'
import { savedPlays, type WatchRow } from '../lib/saved-plays.ts'

// #1703: dazl runs every search on its own AI account. No customer-facing line may send anyone to add, save or replace a
// key of their own, or link to the removed Settings key section.
const BYOK = /AI key|your key|own key|Anthropic key|model-key|bring your own/i
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const BLOCKS = [null, 'not_configured', 'account_cap', 'attempts_cap', 'account_total_cap', 'ip_throttle', 'global_daily_cap', 'google_required', 'domain_used', 'a_reason_not_known_yet']

test('#1703: first-run never mounts a key editor and the retained component cannot send a key', () => {
  assert.equal(src('app/app/first-run.tsx').includes('<KeyInline'), false)
  assert.equal(/fetch\(|<input\b|<form\b/.test(src('app/app/key-inline.tsx')), false)
})

test('#1703: no Settings trial line or next step asks for a key', () => {
  for (const blocked of BLOCKS) for (const funded of [true, false]) for (const remaining of [0, 1, 3]) {
    const c = trialCopy({ funded, remaining, cap: 3, blocked })
    const where = JSON.stringify({ blocked, funded, remaining })
    assert.doesNotMatch(c.text, BYOK, where)
    assert.doesNotMatch(c.next.label, BYOK, where)
    assert.doesNotMatch(c.next.href, BYOK, where)
    assert.ok(c.next.label.trim().length > 0 && c.next.href.length > 0, `${where}: still one real next step`)
  }
})

test('#1703: no refused free-trial notice offers a key, for every refusal reason and account state', () => {
  const accounts = [null, ACCOUNT_LOAD_FAILED, { verified: true, google: false, fresh: true }, { verified: false, google: false, fresh: false }, { verified: true, google: true, fresh: true }] as const
  for (const reason of [...TRIAL_REFUSALS, 'a_reason_not_known_yet', undefined, 42]) {
    assert.doesNotMatch(trialRefusedCopy(reason), BYOK, String(reason))
    for (const account of accounts) {
      const n = trialRefusalNotice(reason, '/app/leads', account)
      assert.doesNotMatch(n.text, BYOK, String(reason))
      for (const a of n.actions) {
        assert.doesNotMatch(`${a.label} ${a.href ?? ''}`, BYOK, `${String(reason)}: action ${a.kind}`)
        assert.notEqual(a.kind as string, 'add_key', `${String(reason)}: no add-key action`)
      }
    }
  }
  for (const r of TRIAL_REFUSALS) assert.doesNotMatch(TRIAL_REFUSAL_COPY[r].text, BYOK, r)
})

test('#1703: the sign-up plan line never mentions a key of your own', () => {
  for (const funded of [true, false]) for (const email of [true, false]) assert.doesNotMatch(signUpPlanLine(funded, email), BYOK, `${funded}/${email}`)
})

test('#1703: a paused play never says it needs a key', () => {
  const T = Date.UTC(2026, 10, 25, 12) / 1000
  const row = (paused_reason: string): WatchRow => ({ id: 'w'.repeat(24), query: 'a saved search', icp: null, active: false, next_run_at: null, last_run_at: null, paused_reason, last_job_id: null, last_status: null, new_leads: 0 })
  for (const reason of ['no_key', 'no_api_key', 'trial_used', 'quota', 'quota_exceeded', 'something_else']) {
    const [p] = savedPlays([row(reason)], [], 'UTC', T)
    assert.doesNotMatch(p.status.label, BYOK, reason)
    assert.match(p.status.label, /^Paused/, reason)
  }
})

test('#1703: Settings has no key panel, no "Model key" link and no mention of your AI key', () => {
  assert.equal(existsSync(new URL('../app/app/settings/llm-key-panel.tsx', import.meta.url)), false, 'the key panel is removed')
  const page = src('app/app/settings/page.tsx')
  assert.doesNotMatch(page, /llm-key-panel|LlmKeyPanel|Model key/)
  assert.doesNotMatch(page, BYOK)
})

test('#1703: the key route reads, writes and removes no stored key and answers 410 Gone to a signed-in caller', () => {
  const route = src('app/api/settings/llm-key/route.ts')
  assert.doesNotMatch(route, /@\/lib\/llm\//, 'nothing from the key store or provider check is imported')
  for (const m of ['GET', 'PUT', 'DELETE']) assert.match(route, new RegExp(`export async function ${m}\\(`), `${m} still answers (an old screen gets a clear reply, not a 405)`)
  assert.match(route, /status: 410/)
  assert.doesNotMatch(route, BYOK, 'its reply names no key to add')
})
