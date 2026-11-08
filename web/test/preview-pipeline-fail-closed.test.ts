// #1008 regression contract for the CI rendered-check pipeline pattern.
// Before the fix, nine web-preview steps and the release-gate scan-transparency step ran
// `node harness | tee log` under `bash -e` WITHOUT pipefail: a failing harness exited through tee, the step
// reported SUCCESS, and the negative SKIP/NOT RUN grep passed on whatever partial output existed. Four steps
// (budget, research-review, infotip-hydration, key-inline-save) reported success while failing. This test pins
// both halves of the contract: the workflow TEXT keeps the fail-closed shape (checked on EVERY workflow file,
// inline `run:` values and block `run: |` bodies alike, with the enable required BEFORE the first tee pipeline,
// and mutation tests proving the checker catches single-line reintroduction, comment-only, off, and late-enable
// shapes), and the SHELL BEHAVIOR actually propagates failure, fires the guards, and stops multi-command blocks
// at the first failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowDir = path.join(repo, '.github/workflows')

// Extract every run value from workflow YAML text: inline `run: <cmd>` and block `run: |` / `run: >` bodies.
function runValues(text: string): string[] {
  const lines = text.split('\n'); const values: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/)
    if (!m) continue
    const indent = m[1].length; const rest = m[2].trim()
    if (rest.startsWith('|') || rest.startsWith('>')) {
      const body: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '') { body.push(''); continue }
        const lead = (l.match(/^(\s*)/)?.[1] ?? '').length
        if (lead <= indent) break
        body.push(l)
      }
      values.push(body.join('\n'))
    } else if (rest) {
      values.push(rest)
    }
  }
  return values
}

// A REAL enable only: `set -o pipefail` or a combined flag group containing o (`set -euo pipefail`).
// Bare `set pipefail` just sets positional parameters and is NOT an enable; `set +o pipefail` is a disable.
function isEnable(c: string): boolean {
  const t = c.trim().split(/\s+/)
  if (t[0] !== 'set' || t[t.length - 1] !== 'pipefail') return false
  const flags = t.slice(1, -1)
  return flags.length > 0 && flags.every(f => /^-[a-z]+$/.test(f)) && flags.some(f => f.includes('o'))
}
const OFF = /^\s*set\s+\+o\s+pipefail/

// Ordered commands of a run value: real lines only (no blanks, no comments), split on && and ;.
function commands(value: string): string[] {
  return value.split('\n')
    .filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
    .flatMap(l => l.split(/&&|;/))
    .map(c => c.trim()).filter(c => c !== '')
}

function checkRunValue(value: string, where: string): string[] {
  const violations: string[] = []
  const cmds = commands(value)
  if (!cmds.some(c => c.includes('| tee'))) return violations
  const enableAt = cmds.findIndex(c => isEnable(c))
  cmds.forEach((c, i) => {
    if (cmds.slice(0, i + 1).some(x => OFF.test(x)) || OFF.test(c))
      violations.push(`${where}: pipefail is explicitly disabled in a tee-piping run value`)
    if (!c.includes('| tee')) return
    if (enableAt === -1) violations.push(`${where}: tee pipeline without any pipefail enable: ${c.slice(0, 120)}`)
    else if (enableAt > i) violations.push(`${where}: pipefail enabled only AFTER the tee pipeline: ${c.slice(0, 120)}`)
    for (const m of c.matchAll(/\|\s*tee\s+(?!-a\b)(\S+)/g)) {
      const f = m[1]
      if (!f.startsWith('/tmp/')) continue
      // The guard must be its own executable command AFTER the producer - a guard inside a comment, a string
      // or an echo argument never runs. Exact-command matching is what keeps those shapes out.
      const guarded = cmds.some((g, j) => j > i && (g === `! grep -q '^SKIP' ${f}` || g === `! grep -q '^NOT RUN' ${f}`))
      if (!guarded) violations.push(`${where}: tee'd log ${f} has no executable fail-closed SKIP/NOT RUN guard after its producer`)
    }
  })
  return violations
}

function checkWorkflowText(text: string, name: string): string[] {
  return runValues(text).flatMap((v, i) => checkRunValue(v, `${name} run value #${i + 1}`))
}

test('static: every tee-piping run value in every workflow file is fail-closed (enable before pipeline, log guard)', () => {
  const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  assert.ok(files.length >= 5, `expected the repo's workflow files, saw ${files.length}`)
  let teeValues = 0; const all: string[] = []
  for (const f of files) {
    const text = readFileSync(path.join(workflowDir, f), 'utf8')
    teeValues += runValues(text).filter(v => v.includes('| tee')).length
    all.push(...checkWorkflowText(text, f))
  }
  assert.ok(teeValues >= 11, `expected at least the 11 known tee-piping run values to be checked, saw ${teeValues}`)
  assert.deepEqual(all, [], `fail-closed violations:\n${all.join('\n')}`)
})

test('mutation: the original single-line `run: node | tee` shape is caught', () => {
  const mutated = "      - name: Budget\n        run: node test/ui/budget.ui.mjs | tee /tmp/b.out && ! grep -q '^SKIP' /tmp/b.out"
  const v = checkWorkflowText(mutated, 'mutated.yml')
  assert.ok(v.some(x => x.includes('without any pipefail enable')), `expected a violation, got ${JSON.stringify(v)}`)
})

test('mutation: a pipefail mention in a comment is not an enable', () => {
  const mutated = "run: |\n  # set -o pipefail\n  node x.mjs | tee /tmp/x.out\n  ! grep -q '^NOT RUN' /tmp/x.out"
  assert.ok(checkWorkflowText(mutated, 'mutated.yml').length > 0, 'comment-only pipefail must fail')
})

test('mutation: set +o pipefail is caught', () => {
  const mutated = "run: |\n  set +o pipefail\n  node x.mjs | tee /tmp/x.out\n  ! grep -q '^NOT RUN' /tmp/x.out"
  assert.ok(checkWorkflowText(mutated, 'mutated.yml').length > 0, 'an explicit disable must fail')
})

test('mutation: pipefail enabled only after the producer is caught', () => {
  const mutated = "run: |\n  node x.mjs | tee /tmp/x.out\n  set -o pipefail\n  ! grep -q '^NOT RUN' /tmp/x.out"
  assert.ok(checkWorkflowText(mutated, 'mutated.yml').length > 0, 'a late enable must fail')
})

test('mutation: a tee\'d log without its SKIP/NOT RUN guard is caught', () => {
  const mutated = "run: |\n  set -o pipefail\n  node x.mjs | tee /tmp/x.out"
  assert.ok(checkWorkflowText(mutated, 'mutated.yml').length > 0, 'a missing log guard must fail')
})

test('mutation: a dash-key `- run:` value is checked, not ignored', () => {
  const mutated = "      - run: node x.mjs | tee /tmp/x.out && ! grep -q '^NOT RUN' /tmp/x.out"
  const v = checkWorkflowText(mutated, 'mutated.yml')
  assert.ok(v.some(x => x.includes('without any pipefail enable')), `expected a violation, got ${JSON.stringify(v)}`)
})

test('mutation: bare `set pipefail` (positional args, no -o) is not an enable', () => {
  const mutated = "run: |\n  set pipefail\n  node x.mjs | tee /tmp/x.out\n  ! grep -q '^NOT RUN' /tmp/x.out"
  assert.ok(checkWorkflowText(mutated, 'mutated.yml').length > 0, 'bare set pipefail must fail')
})

test('mutation: a guard inside an inline comment or string never counts', () => {
  const commented = "run: |\n  set -o pipefail\n  node x.mjs | tee /tmp/x.out\n  echo done # ! grep -q '^NOT RUN' /tmp/x.out"
  assert.ok(checkWorkflowText(commented, 'mutated.yml').length > 0, 'a guard in a trailing comment must fail')
  const inString = "run: |\n  set -o pipefail\n  node x.mjs | tee /tmp/x.out\n  echo \"! grep -q '^NOT RUN' /tmp/x.out\""
  assert.ok(checkWorkflowText(inString, 'mutated.yml').length > 0, 'a guard inside a string must fail')
})

test('control: the current fail-closed shape passes the checker', () => {
  const good = "run: |\n  set -o pipefail\n  node x.mjs | tee /tmp/x.out\n  ! grep -q '^NOT RUN' /tmp/x.out"
  assert.deepEqual(checkWorkflowText(good, 'good.yml'), [])
})

// Every inline esbuild shim in the UI harnesses must parse as its own module, with a real JS unescape of the
// quoted literal (an outer node --check never sees the embedded JS, and a naive string replace is not an unescape).
test('inline: every UI harness esbuild shim contents parses as its own module with exactly one randomBytes export', () => {
  const uiDir = path.join(repo, 'web/test/ui')
  let checked = 0
  for (const f of readdirSync(uiDir).filter(f => f.endsWith('.ui.mjs'))) {
    const s = readFileSync(path.join(uiDir, f), 'utf8')
    for (const m of s.matchAll(/contents: ('(?:[^'\\]|\\.)*')/g)) {
      // Decode the quoted literal with the TypeScript AST (StringLiteral.text) - a real unescape, no eval.
      const litFile = ts.createSourceFile('lit.ts', `const v = ${m[1]};`, ts.ScriptTarget.Latest, true)
      const stmt = litFile.statements[0]
      assert.ok(stmt && ts.isVariableStatement(stmt), `${f}: shim literal must parse as a variable statement`)
      const init = stmt.declarationList.declarations[0]?.initializer
      assert.ok(init && ts.isStringLiteral(init), `${f}: shim contents must be a string literal`)
      const body: string = init.text
      const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'dazl-shim-')), 'shim.mjs')
      writeFileSync(tmp, body)
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
      rmSync(path.dirname(tmp), { recursive: true, force: true })
      assert.equal(r.status, 0, `${f}: inline shim module does not parse: ${r.stderr.split('\n')[0]}`)
      assert.equal(body.match(/export const randomBytes/g)?.length ?? 0, 1, `${f}: exactly one randomBytes export`)
      checked++
    }
  }
  assert.ok(checked >= 8, `expected the 8 known shimmed harnesses, checked ${checked}`)
})

const hasBash = spawnSync('bash', ['--version']).status === 0
const behave = hasBash ? test : test.skip
const run = (script: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dazl-pipe-'))
  try { return spawnSync('bash', ['-e', '-c', script.replaceAll('$D', dir)], { encoding: 'utf8' }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

behave('behavior: the OLD pattern (no pipefail) really does mask a failing harness - the bug this pins against', () => {
  const r = run(`node -e "process.exit(1)" | tee $D/out && ! grep -q '^SKIP' $D/out`)
  assert.equal(r.status, 0, 'without pipefail the failing node exit never reaches the step (the documented mask)')
})

behave('behavior: pipefail makes a failing harness fail the step', () => {
  const r = run(`set -o pipefail\nnode -e "process.exit(1)" | tee $D/out\n! grep -q '^SKIP' $D/out`)
  assert.notEqual(r.status, 0, 'the node failure must reach the step status')
})

behave('behavior: the SKIP guard fails the step when the harness skips', () => {
  const r = run(`set -o pipefail\nnode -e "console.log('SKIP: no playwright')" | tee $D/out\n! grep -q '^SKIP' $D/out`)
  assert.notEqual(r.status, 0, 'a SKIP must fail a check step, never report success')
})

behave('behavior: the NOT RUN guard fails the step when the harness cannot run', () => {
  const r = run(`set -o pipefail\nnode -e "console.log('NOT RUN: no production build')" | tee $D/out\n! grep -q '^NOT RUN' $D/out`)
  assert.notEqual(r.status, 0, 'a NOT RUN must fail a check step, never report success')
})

behave('behavior: a multi-command block stops at the first failing harness', () => {
  const r = run(`set -o pipefail\nnode -e "process.exit(1)" | tee $D/a.out\n! grep -q '^NOT RUN' $D/a.out\nnode -e "console.log('second ran')" | tee $D/b.out\n! grep -q '^NOT RUN' $D/b.out`)
  assert.notEqual(r.status, 0, 'the first failure must fail the step')
  assert.ok(!r.stdout.includes('second ran'), 'the second command must not run after the first fails')
})

behave('behavior: a passing harness with clean output passes the step (no false failure)', () => {
  const r = run(`set -o pipefail\nnode -e "console.log('PASS real check')" | tee $D/out\n! grep -q '^SKIP' $D/out\n! grep -q '^NOT RUN' $D/out`)
  assert.equal(r.status, 0, `a real pass must pass (got ${r.status}: ${r.stderr})`)
})
