#!/usr/bin/env node
// Tagged-test evidence check (docs/design/issue-closure-gate.md). Additive evidence only: a PASS is
// necessary-but-never-sufficient for closing an issue. Issues are closed by the reviewer/owner after the fix is
// deployed and verified live (docs/PROCESS.md § "Closing issues"); builders never use closing keywords.
//
// A test is "tagged #N" only when its own test()/it() NAME contains "#N". A comment, a describe() title, a
// fixture, or "#N" as a prefix of a longer number does not count. The gate runs every file that declares such a
// test and counts, from the runner's own per-test events, what actually executed.
//
// GATE #N: PASS  iff  >= 1 tagged test executed (not skipped, not todo) and every executed tagged test passed,
//                     and nothing else in the files run failed (runner exit 0).
// GATE #N: FAIL  otherwise: no test named #N, every tagged test skipped/todo, any failure, runner not started.
//
// Usage: node scripts/gate-check.mjs <issue-number> [...]          exit 0 all PASS, 1 any FAIL, 2 bad usage
//        node scripts/gate-check.mjs --list <issue-number> [...]   static scan only (runs nothing): prints
//          "numbers=<comma-separated issues that declare >= 1 test named #N>"; exit 0, or 2 on bad usage.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DIRS = ['test']
const SKIP_DIRS = new Set(['fixtures', 'node_modules'])
const REPORTER = './scripts/gate-check-reporter.mjs'
// Issue numbers are 1-7 digits, no leading zero; anything else is a usage error, never a regex fragment.
export const ISSUE_RE = /^[1-9][0-9]{0,6}$/
const tagIn = (n) => new RegExp(`#${n}(?![0-9])`)
// A test()/it() call (incl. .only/.skip/.todo) whose first string-literal argument contains #N.
const declRe = (n) => new RegExp(`\\b(?:test|it)(?:\\.\\w+)?\\(\\s*(['"\`])(?:(?!\\1)[^\\\\\\n]|\\\\.)*?#${n}(?![0-9])`)

function listTestFiles(absDir, skipDirs) {
  const out = []
  for (const name of readdirSync(absDir)) {
    const p = join(absDir, name)
    const st = statSync(p)
    if (st.isDirectory()) { if (!skipDirs.has(name)) out.push(...listTestFiles(p, skipDirs)) }
    else if (/\.test\.(ts|mts|mjs)$/.test(name)) out.push(relative(WEB_ROOT, p).split('\\').join('/'))
  }
  return out
}

export function filesDeclaring(n, dirs = DEFAULT_DIRS) {
  if (!ISSUE_RE.test(String(n))) throw new Error(`not an issue number: ${JSON.stringify(n)}`)
  const re = declRe(n)
  const skipDirs = dirs === DEFAULT_DIRS ? SKIP_DIRS : new Set(['node_modules'])
  return dirs.flatMap((d) => listTestFiles(resolve(WEB_ROOT, d), skipDirs)).sort()
    .filter((f) => re.test(readFileSync(join(WEB_ROOT, f), 'utf8')))
}

function runFiles(files) {
  // NODE_TEST_CONTEXT (set when this runs under node --test) would make the child stream to a parent runner
  // instead of our reporter, so nothing would be counted: drop it.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const res = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import', './test/helpers/net-fence.ts',
    `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', '--test', ...files,
  ], { cwd: WEB_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' } })
  const events = []
  for (const line of (res.stdout ?? '').split('\n')) {
    if (!line.startsWith('{"gate":1')) continue
    try { events.push(JSON.parse(line)) } catch { /* a malformed line counts as nothing executed */ }
  }
  return { status: res.status, error: res.error ? String(res.error.message ?? res.error) : null, events, stderr: res.stderr ?? '' }
}

export function gate(n, dirs = DEFAULT_DIRS) {
  const files = filesDeclaring(n, dirs)
  if (files.length === 0) {
    return { n, ok: false, counts: null, files, reason: `no test is NAMED with "#${n}" (comments and describe titles do not count)` }
  }
  const run = runFiles(files)
  const tag = tagIn(n)
  const tagged = run.events.filter((e) => tag.test(e.name))
  const c = {
    executed: tagged.filter((e) => !e.skip && !e.todo).length,
    passed: tagged.filter((e) => e.ok && !e.skip && !e.todo).length,
    failed: tagged.filter((e) => !e.ok && !e.todo).length,
    skipped: tagged.filter((e) => e.skip).length,
    todo: tagged.filter((e) => e.todo).length,
    otherFailed: run.events.filter((e) => !tag.test(e.name) && !e.ok && !e.todo).length,
    exit: run.status,
  }
  const counts = `tagged executed=${c.executed} passed=${c.passed} failed=${c.failed} skipped=${c.skipped} todo=${c.todo}; other failures=${c.otherFailed}; runner exit=${c.exit}`
  let reason = null
  if (run.error) reason = `test runner did not run: ${run.error}`
  else if (c.executed === 0) reason = 'no tagged test executed (all skipped/todo, or none ran)'
  else if (c.failed > 0 || c.passed !== c.executed) reason = 'a tagged test failed'
  else if (c.otherFailed > 0 || c.exit !== 0) reason = 'something else in the tagged files failed'
  const failedNames = run.events.filter((e) => !e.ok && !e.todo).map((e) => e.name).slice(0, 20)
  return { n, ok: reason === null, c, counts, files, failedNames, reason: reason ?? 'tagged tests executed and passed', stderr: run.stderr }
}

export function main(argv, dirs = DEFAULT_DIRS, log = console.log, err = console.error) {
  const list = argv[0] === '--list'
  const args = (list ? argv.slice(1) : argv).map((s) => String(s).replace(/^#/, ''))
  const bad = args.filter((s) => !ISSUE_RE.test(s))
  if (args.length === 0 || bad.length > 0) {
    err(`usage: node scripts/gate-check.mjs [--list] <issue-number> [...]${bad.length ? ` (not an issue number: ${bad.map((b) => JSON.stringify(b)).join(', ')})` : ''}`)
    return 2
  }
  const nums = [...new Set(args)]
  if (list) {
    log(`numbers=${nums.filter((n) => filesDeclaring(n, dirs).length > 0).join(',')}`)
    return 0
  }
  let allOk = true
  for (const n of nums) {
    const r = gate(n, dirs)
    allOk &&= r.ok
    log(`GATE #${n}: ${r.ok ? 'PASS' : 'FAIL'} — ${r.reason}${r.counts ? ` (${r.counts})` : ''}${r.files.length ? `; files: ${r.files.join(', ')}` : ''}`)
    if (!r.ok && r.failedNames?.length) err(`  failed: ${r.failedNames.map((s) => JSON.stringify(s)).join(', ')}`)
    if (!r.ok && r.stderr) err(r.stderr.slice(-4000))
  }
  log('Evidence only: a PASS never closes an issue. The reviewer/owner closes it after deploy + live proof.')
  return allOk ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
