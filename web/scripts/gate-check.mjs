#!/usr/bin/env node
// Issue-closure gate (docs/design/issue-closure-gate.md). Formalizes a pattern builders already use ad hoc
// (see test/crm-contract.test.ts, test/crm-acceptance.test.ts: tests named "#569 repro", "#569 read-back" etc.)
// into a mechanical check: a PR that claims "Closes #N" must have a test file tagged #N, and that test must
// currently pass. This replaces free-text self-attestation ("GATE 8/8") with a command Instinct, CI, or a
// builder can run and trust.
//
// Usage: node scripts/gate-check.mjs <issue-number> [<issue-number> ...]
// Exit code: 0 if every gate passes, 1 if any issue has no tagged test or its tagged test fails.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const TEST_DIRS = ['test']
const TAG_RE = (n) => new RegExp(`(?:^|[^0-9])#${n}(?:[^0-9]|$)`)

function listTestFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...listTestFiles(p))
    else if (/\.test\.(ts|mts|mjs)$/.test(name)) out.push(p)
  }
  return out
}

function findTaggedFiles(issueNumber) {
  const re = TAG_RE(issueNumber)
  const hits = []
  for (const dir of TEST_DIRS) {
    for (const file of listTestFiles(dir)) {
      const text = readFileSync(file, 'utf8')
      if (re.test(text)) hits.push(file)
    }
  }
  return hits
}

function runFiles(files) {
  const res = spawnSync('node', [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--test', ...files,
  ], { encoding: 'utf8', env: { ...process.env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' } })
  const out = `${res.stdout}\n${res.stderr}`
  const failMatch = /# fail (\d+)/.exec(out)
  const passMatch = /# pass (\d+)/.exec(out)
  const fail = failMatch ? Number(failMatch[1]) : res.status !== 0 ? 1 : 0
  return { ok: fail === 0 && res.status === 0, pass: passMatch ? Number(passMatch[1]) : null, fail, out }
}

function gate(issueNumber) {
  const files = findTaggedFiles(issueNumber)
  if (files.length === 0) {
    return { issueNumber, ok: false, reason: `no test file under test/ tags "#${issueNumber}" — add one before this PR can claim Closes #${issueNumber}` }
  }
  const result = runFiles(files)
  if (!result.ok) {
    return { issueNumber, ok: false, reason: `tagged test(s) failed: ${files.join(', ')} (${result.fail} failing)`, files }
  }
  return { issueNumber, ok: true, reason: `${files.length} tagged test file(s) green: ${files.join(', ')}`, files }
}

const issueNumbers = process.argv.slice(2).map((s) => s.replace(/^#/, ''))
if (issueNumbers.length === 0) {
  console.error('usage: node scripts/gate-check.mjs <issue-number> [<issue-number> ...]')
  process.exit(2)
}

let allOk = true
for (const n of issueNumbers) {
  const r = gate(n)
  allOk &&= r.ok
  console.log(`GATE #${n}: ${r.ok ? 'PASS' : 'FAIL'} — ${r.reason}`)
}
process.exit(allOk ? 0 : 1)
