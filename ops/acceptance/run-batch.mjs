#!/usr/bin/env node
// Gate 4 scripted acceptance (Hermes-PC review of #1298, fix A2). Runs each issue's OWN check against a deployed base URL.
// usage: node ops/acceptance/run-batch.mjs <manifest.json> <base-url> <sha>
// manifest: [{ "issue": 1116, "check": "ops/acceptance/checks/signup-hydrates.sh" }, ...]  (path relative to repo root)
// Each check gets BASE_URL and SHA in its env; exit 0 = PASS, anything else (or a 120 s timeout) = FAIL.
// Prints "Quest live check (prod <sha>): PASS #N" ONLY for issues whose own check passed; exits 1 if any check failed or
// the manifest is empty. Healthy pages never make a broken feature pass: page smoke is a separate step (A1).
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const [manifestPath, base, sha] = process.argv.slice(2)
if (!manifestPath || !base || !sha) { console.error('usage: run-batch.mjs <manifest.json> <base-url> <sha>'); process.exit(2) }
let list
try { list = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (e) { console.error(`bad manifest: ${e.message}`); process.exit(2) }
if (!Array.isArray(list) || list.length === 0) { console.error('FAIL: empty manifest, nothing proven'); process.exit(1) }
let failed = 0
for (const { issue, check } of list) {
  if (!Number.isInteger(issue) || typeof check !== 'string' || !existsSync(check)) {
    console.log(`FAIL #${issue}: missing or invalid check ${check}`); failed++; continue
  }
  const r = spawnSync(check.endsWith('.mjs') ? process.execPath : 'bash', [check], {
    env: { ...process.env, BASE_URL: base, SHA: sha }, encoding: 'utf8', timeout: 120_000,
  })
  const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join(' | ')
  if (r.status === 0) console.log(`Quest live check (prod ${sha}): PASS #${issue}  ${tail}`)
  else { failed++; console.log(`FAIL #${issue} (exit ${r.status ?? r.signal}): ${tail}`) }
}
console.log(`${list.length - failed}/${list.length} issue checks passed`)
process.exit(failed ? 1 : 0)
