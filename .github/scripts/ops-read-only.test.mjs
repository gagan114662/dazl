// NEVER-AGAIN #13: lanes only READ through the ops door. 2026-11-13 ~22:40 a verifier lane called the ops door's
// env-write endpoint during a read-only-intended probe and wiped the staging trial allowlist.
// This file keeps the gate wired: the entry exists, the read-only client is the repo's only ops-door client, and its
// behavioural test runs in never-again-gates.yml on every pull request.
// Run: node --test '.github/scripts/*.test.mjs' (never-again-gates.yml picks this file up by that glob).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const read = p => readFileSync(path.join(repo, p), 'utf8')

test('NEVER-AGAIN has the ops-door read-only entry, and it cites the client and its test', () => {
  const doc = read('docs/NEVER-AGAIN.md')
  const entry = doc.split(/^## /m).find(e => /ops door/i.test(e.split('\n')[0]))
  assert.ok(entry, 'no NEVER-AGAIN entry about the ops door')
  assert.match(entry, /\*\*Enforced by \(automated\):\*\*/, 'the ops-door entry must be automated, not note-only')
  for (const p of ['ops/ops_read.sh', 'ops/test_ops_read_only.py'])
    assert.ok(entry.includes('`' + p + '`'), `the entry must cite ${p}`)
})

test('the read-only ops-door client names no HTTP method and forces a GET', () => {
  const code = read('ops/ops_read.sh').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(code, /(^|\s)(-X|--request)(\s|=)/m, 'ops_read.sh must never set an HTTP method')
  assert.match(code, /curl[^\n]*\s-G\s/, 'ops_read.sh must force a GET with -G')
  // the refusal list, so dropping any of these shows up here as well as in the python test
  assert.match(code, /\(env\|config\|settings\?/, 'ops_read.sh must still refuse env/config/settings write paths')
  assert.match(code, /\(set\|unset\|/, 'ops_read.sh must still refuse set/unset path verbs')
  for (const needle of ['mail/enable', 'unset=', 'rollback', 'NEVER-AGAIN.md #13'])
    assert.ok(code.includes(needle), `ops_read.sh must still refuse / mention ${needle}`)
})

test('the ops-door read-only test runs in never-again-gates.yml on every pull request', () => {
  const wf = read('.github/workflows/never-again-gates.yml')
  assert.ok(wf.split('\n').some(l => l.trim() === "run: python3 -m unittest discover -s ops -p 'test_ops_read_only.py' -v"),
    'never-again-gates.yml must run ops/test_ops_read_only.py in its own step')
  assert.ok(existsSync(path.join(repo, 'ops/test_ops_read_only.py')))
})

test('ops_read.sh is the only ops-door client in the repo: no script under ops/** writes env through the door', () => {
  const writeMethod = /-X\s*['"]?(POST|PUT|PATCH|DELETE)|--request[= ]['"]?(POST|PUT|PATCH|DELETE)|--data|--upload-file/i
  const envWritePath = /(__ops|\$OPS|\$\{OPS\}|ops)[^\s'"]*\/(env\/(set|unset|update|write|delete)|config\/(set|unset|update)|settings?\/(set|update)|secrets?\/set|mail\/(enable|disable))/i
  const self = 'ops/test_ops_read_only.py' // holds the scanner's own negative control
  const offenders = []
  const walk = dir => {
    for (const name of readdirSync(path.join(repo, dir))) {
      const rel = `${dir}/${name}`
      if (name === '__pycache__' || name === 'node_modules') continue
      if (statSync(path.join(repo, rel)).isDirectory()) { walk(rel); continue }
      if (!/\.(sh|py|mjs|js|ts)$/.test(name) || rel === self) continue
      read(rel).split('\n').forEach((line, i) => {
        if (envWritePath.test(line) && writeMethod.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`)
      })
    }
  }
  walk('ops')
  assert.deepEqual(offenders, [], `ops scripts writing env through the ops door: ${offenders.join(' | ')}`)
  // negative control: the patterns fire on the exact call that caused entry 13
  const bad = `curl -s -X POST --data-binary 'a,b' "$OPS/env/set?env=staging&key=DAZL_TRIAL_EMAIL_DOMAINS"`
  assert.ok(envWritePath.test(bad) && writeMethod.test(bad), 'the scanner must catch the real offender')
  assert.ok(!(envWritePath.test('bash ops/ops_read.sh "/env?env=staging"')), 'a plain read must not be flagged')
})
