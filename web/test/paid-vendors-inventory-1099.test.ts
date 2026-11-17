// Refs #1099 (lib/paid-vendors.ts): every module that imports a paid third-party client (Apollo, PDL, ZeroBounce, Jina Reader) or reads
// a tenant's model keys must import the paid-vendor policy, or be listed below with the reason it needs none. A new call site that skips
// the policy fails here, even though the test fence names every vendor for the rest of the suite (council review).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
// a paid client, a paid host named in code, or a module that CHOOSES a model vendor itself (reads the key table or keyStatus directly, or asks
// for an OpenAI key / provider by name). Calling an already-gated selector (pickVendor, defaultVendor, hasKey, readHasKey, usableVendor) is
// not choosing (council round 2).
const PAID = /from ['"][^'"]*(?:enrich\/apollo|enrich\/pdl|people\/zerobounce|scrape\/jina|\.\/apollo|\.\/pdl|\.\/zerobounce)(?:\.ts)?['"]|import\(['"][^'"]*(?:enrich\/apollo|enrich\/pdl|people\/zerobounce|scrape\/jina)|r\.jina\.ai|api\.openai\.com|api\.apollo\.io|api\.peopledatalabs\.com|api\.zerobounce\.net|tenant_llm_keys|\b(?:keyStatus|readKeyStatus)\(|\b(?:readKey|getKey|fetchKey|readTenantKey)\([^)]*['"]openai['"]|providers(?:\.openai|\[\s*['"]openai['"]\s*\])/
// it must IMPORT the policy (paidVendorOn / paidVendorsAllowed / usableVendor / PAID_VENDOR_OFF), not merely mention the file's name
const USES_POLICY = /import\s*\{[^}]*\b(?:paidVendorOn|paidVendorsAllowed|usableVendor|PAID_VENDOR_OFF)\b[^}]*\}\s*from\s*['"][^'"]*paid-vendors/
export const offends = (src: string): boolean => PAID.test(src) && !USES_POLICY.test(src)
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
  'lib/llm/provider.ts': 'the model clients themselves; which one runs is chosen by the gated selectors (usableVendor)',
  'lib/enrich/apollo.ts': 'the Apollo client itself (names its host); every caller is gated',
  'lib/people/zerobounce.ts': 'the ZeroBounce client itself (names its host); verifierFromEnv is gated',
  'app/app/settings/enrichment-panel.tsx': 'names the Apollo host in help text; makes no request',
  'lib/llm/vendors.ts': 'checks a key with its vendor; the save route refuses an OpenAI key unless named, before this runs',
  'lib/evals/trace.ts': 'classifies recorded request URLs in an eval trace; makes no request',
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
    if (offends(src)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], 'import lib/paid-vendors.ts (paidVendorOn / usableVendor) or add the module to EXEMPT with a reason')
  const stale = Object.keys(EXEMPT).filter(k => !seen.has(k))
  assert.deepEqual(stale, [], 'an EXEMPT entry no longer matches: remove it')
})

test('the check itself catches what it should (synthetic sources)', () => {
  for (const bad of [
    "await fetch('https://api.apollo.io/v1/people/match')",
    'const r = await fetch("https://api.peopledatalabs.com/v5/person/enrich")',
    "fetch('https://api.zerobounce.net/v2/validate')",
    'import { apolloPersonMatch } from "../enrich/apollo.ts"',
    "const { pdlPeopleSearch } = await import('../enrich/pdl.ts')",
    "const k = readKey(db, t, 'openai')",
    "const rows = db.prepare('SELECT vendor FROM tenant_llm_keys').all()",
    "// see lib/paid-vendors.ts\nawait fetch('https://api.apollo.io/v1/x')",   // a mention of the file is not the policy
  ]) assert.equal(offends(bad), true, bad)
  assert.equal(offends("import { paidVendorOn } from '../paid-vendors.ts'\nawait fetch('https://api.apollo.io/v1/x')"), false)
  assert.equal(offends("const v = pickVendor(db, t)"), false)
})
