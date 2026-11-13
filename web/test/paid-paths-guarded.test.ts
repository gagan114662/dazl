// Every paid model call in lib/ and app/ is behind a spend guard (#363): each module that calls a provider's complete,
// completeDetailed or research is either on the owner's workspace pool itself (lib/llm/owner-guard.ts) or listed here
// with where its guarded provider comes from. A new paid call site fails this test until it is guarded and listed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))
const PAID_CALL = /\.(?:complete|completeDetailed)!?\(|\.research\(/

// Modules that call the provider through ownerGuarded (they must name it).
const OWNER_GUARDED = [
  'lib/outreach/draft-llm.ts', 'lib/outreach/sequences.ts', 'lib/replies/threads.ts', 'lib/scan/icp-from-site.ts',
  'lib/seo/brief.ts', 'lib/seo/newsjack.ts',
]
// Modules that make the call on a provider they are handed, and who hands it to them guarded.
const HANDED_A_GUARDED_PROVIDER: Record<string, string> = {
  'lib/scan/runner.ts': 'guardProvider over the run, job and owner-pool guards (providers_)',
  'lib/scan/score.ts': 'scoreLeads(provider, ...) is called by the runner with providers_',
  'lib/scan/buyer-fit.ts': 'applyBuyerFitGate(provider, ...) is called by the runner with providers_',
  'lib/scan/model-usage.ts': 'records usage around the runner\'s guarded provider',
  'lib/scan/lead-qualify.ts': 'qualifyLead(provider, ...) is called only by qualify-run.ts with ownerGuarded',
  'lib/evals/trace.ts': 'offline eval tooling: wraps a provider it is handed, never in the app',
  'lib/llm/owner-guard.ts': 'the owner guard itself (#846/#847): delegates each call of the provider it is handed inside the account spend context (inAccount), adding no call of its own',
  'lib/outreach/launch-policy.ts': 'launchProviders wraps the provider autopilot hands it (the launch spend cap, #405); draft-llm then calls the wrapped provider through ownerGuarded, so every call is inside the owner guard. The guarantee holds only while polishDraft/pickProvider is the sole consumer of launchProviders; a future caller bypassing pickProvider would be unguarded and this test would not catch it',
}
// Not call sites: the providers themselves, the guard, and the queue's own complete(token).
const NOT_A_CALL_SITE = new Set(['lib/llm/provider.ts', 'lib/llm/vendors.ts', 'lib/llm/spend-guard.ts', 'lib/queue/db.ts', 'lib/queue/sqlite.ts', 'lib/queue/memory.ts', 'lib/queue/scan-claimer.ts', 'lib/queue/types.ts', 'lib/scan/queue-runner.ts'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [] })
}

test('every module that makes a paid model call is on the owner\'s spend pool or handed a guarded provider', () => {
  const found = [...files(join(web, 'lib')), ...files(join(web, 'app'))].map(p => relative(web, p).replace(/\\/g, '/')).filter(p => !NOT_A_CALL_SITE.has(p) && PAID_CALL.test(readFileSync(join(web, p), 'utf8'))).sort()
  const known = [...OWNER_GUARDED, ...Object.keys(HANDED_A_GUARDED_PROVIDER)].sort()
  assert.deepEqual(found, known, 'a paid call site is new or gone: guard it with ownerGuarded (lib/llm/owner-guard.ts) and list it here')
  for (const p of OWNER_GUARDED) assert.match(readFileSync(join(web, p), 'utf8'), /ownerGuarded\(/, `${p} must call through ownerGuarded`)
  // lead-qualify's only caller hands it the guarded provider.
  assert.match(readFileSync(join(web, 'lib/scan/qualify-run.ts'), 'utf8'), /qualifyLead\(ownerGuarded\(/)
})

// Every credit-charging BYOK enrichment call (#363) reserves on the workspace credit pool (lib/enrich/credit-pool.ts)
// before it is made: Apollo organizations/enrich (1 credit) and PDL person search (1 credit per profile returned).
// Apollo's people search is documented as 0 credits and is not listed. A new caller fails until it reserves and is
// listed here.
const CREDIT_CALL = /\b(?:apolloOrgEnrich|pdlPeopleSearch)\(/
const CREDIT_RESERVING: Record<string, RegExp[]> = {
  'lib/enrich/index.ts': [/reserveCredits\(db, tenantId, 'apollo', 1,/, /reserveCredits\(db, tenantId, 'pdl', size,/],
  'lib/scan/commenter-import.ts': [/holdCredits\(db, tenantId, 'apollo', 1,/, /holdCredits\(db, tenantId, 'pdl', 5,/],
}
const NOT_A_CREDIT_CALL_SITE = new Set(['lib/enrich/apollo.ts', 'lib/enrich/pdl.ts'])
test('every module that makes a credit-charging enrichment call reserves on the workspace credit pool first', () => {
  const found = [...files(join(web, 'lib')), ...files(join(web, 'app'))].map(p => relative(web, p).replace(/\\/g, '/'))
    .filter(p => !NOT_A_CREDIT_CALL_SITE.has(p) && CREDIT_CALL.test(readFileSync(join(web, p), 'utf8'))).sort()
  assert.deepEqual(found, Object.keys(CREDIT_RESERVING).sort(), 'a credit-charging call site is new or gone: reserve with lib/enrich/credit-pool.ts and list it here')
  for (const [p, res] of Object.entries(CREDIT_RESERVING)) for (const re of res) assert.match(readFileSync(join(web, p), 'utf8'), re, `${p} must reserve credits before its paid calls`)
})
