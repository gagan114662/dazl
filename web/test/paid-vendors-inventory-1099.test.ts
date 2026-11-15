// Refs #1099 (lib/paid-vendors.ts): every module that imports a paid third-party client (Apollo, PDL, ZeroBounce, Jina Reader) or reads
// a tenant's model keys must import the paid-vendor policy, or be listed below with the reason it needs none. A new call site that skips
// the policy fails here, even though the test fence names every vendor for the rest of the suite (council review).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const PAID = /from '[^']*(?:enrich\/apollo|enrich\/pdl|people\/zerobounce|scrape\/jina|\.\/apollo|\.\/pdl|\.\/zerobounce)(?:\.ts)?'|r\.jina\.ai|tenant_llm_keys|\bkeyStatus\(|\breadKeyStatus\(/
// modules that match but never decide whether a paid vendor is called
const EXEMPT: Record<string, string> = {
  'lib/enrich/pdl.ts': 'the PDL client itself; every caller is gated',
  'lib/scrape/jina.ts': 'the Jina Reader client itself; funding-round is gated',
  'lib/llm/key-evidence.ts': 'reads when keys were validated, chooses nothing',
  'lib/legal/policy.ts': 'the disclosed-host list (text), makes no request',
  'lib/scan/store.ts': 'imports only the Apollo timeout constant',
  'lib/queue/scan-claimer.ts': 'claims a pending job of a keyed tenant; intake (hasKey) is gated, the runner picks the vendor',
  'lib/scan/queue-runner.ts': 'claims a pending job of a keyed tenant; intake (hasKey) is gated, the runner picks the vendor',
  'lib/scan/worker.ts': 'checks the tables exist and whether work is pending; chooses nothing',
  'lib/secrets-rewrap.ts': 're-encrypts stored keys, calls nothing',
  'lib/tenant/lifecycle.ts': 'deletes a deleted tenant\'s credential rows, calls nothing',
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : /\.tsx?$/.test(n) ? [p] : [] })
}

test('every module that can reach a paid vendor or choose a model key goes through lib/paid-vendors.ts', () => {
  const offenders: string[] = []
  const seen = new Set<string>()
  for (const f of [...files(join(ROOT, 'lib')), ...files(join(ROOT, 'app'))]) {
    const rel = relative(ROOT, f), src = readFileSync(f, 'utf8')
    if (rel === 'lib/paid-vendors.ts' || !PAID.test(src)) continue
    seen.add(rel)
    if (EXEMPT[rel]) continue
    if (!/paid-vendors/.test(src)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], 'import lib/paid-vendors.ts (paidVendorOn / usableVendor) or add the module to EXEMPT with a reason')
  const stale = Object.keys(EXEMPT).filter(k => !seen.has(k))
  assert.deepEqual(stale, [], 'an EXEMPT entry no longer matches: remove it')
})
