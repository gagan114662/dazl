// #1089 acceptance 2: the deletion ledger must be append-only, yet the app (not root) writes it. Both hold together:
// the app user owns the file and only ever opens it for append, and ops/backup/install-prod.sh sets the kernel's
// append-only flag (chattr +a), which lets an append through and refuses any rewrite, truncation or delete. The
// installer must FAIL CLOSED: if it cannot prove the flag is on (read back with lsattr), it exits nonzero before
// any unit is installed or enabled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, openSync, writeSync, fsyncSync, closeSync,
  truncateSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const helper = `${repo}ops/backup/ledger-append-only.sh`
const install = readFileSync(`${repo}ops/backup/install-prod.sh`, 'utf8')
const ledger = readFileSync(`${repo}web/lib/tenant/ledger.ts`, 'utf8')

// Runs the real helper the installer sources, with fake chattr/lsattr first on PATH. Each fake records its calls;
// lsattr prints the flags kept in a state file, which a working fake chattr +a updates.
type Fake = { chattr?: 'missing' | 'ok' | 'fail' | 'noop', lsattr?: 'missing' | 'ok' | 'fail', startFlags?: string }
function runHelper(f: Fake) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger1089-'))
  const bin = join(dir, 'bin'); spawnSync('mkdir', ['-p', bin])
  const state = join(dir, 'flags'); writeFileSync(state, f.startFlags ?? '--------------e-------')
  const target = join(dir, 'tombstones.jsonl'); writeFileSync(target, '')
  const put = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  if ((f.lsattr ?? 'ok') === 'ok') put('lsattr', `echo "$(cat '${state}') \${@: -1}"`)
  if (f.lsattr === 'fail') put('lsattr', `echo "lsattr: Operation not supported While reading flags" >&2; exit 1`)
  const c = f.chattr ?? 'ok'
  if (c === 'ok') put('chattr', `echo -----a--------e------- > '${state}'`)
  if (c === 'fail') put('chattr', `echo "chattr: Operation not permitted while setting flags" >&2; exit 1`)
  if (c === 'noop') put('chattr', 'exit 0')
  // only the fakes plus the basic tools; no real chattr/lsattr can leak in from /usr/bin
  const sys = join(dir, 'sys'); spawnSync('mkdir', ['-p', sys])
  for (const t of ['cat', 'echo', 'awk', 'grep', 'bash']) {
    const p = spawnSync('bash', ['-c', `command -v ${t}`]).stdout.toString().trim()
    if (p.startsWith('/')) spawnSync('ln', ['-s', p, join(sys, t)])
  }
  const r = spawnSync('/bin/bash', ['-c', `source '${helper}' && ensure_ledger_append_only '${target}'`],
    { env: { ...process.env, PATH: `${bin}:${sys}` }, encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

test('fails closed when chattr is missing', () => {
  const r = runHelper({ chattr: 'missing' })
  assert.notEqual(r.code, 0, r.out); assert.match(r.out, /chattr.*not found/)
})
test('fails closed when chattr +a is refused', () => {
  const r = runHelper({ chattr: 'fail' })
  assert.notEqual(r.code, 0, r.out); assert.match(r.out, /could not set .* append-only/)
})
test('fails closed when lsattr is missing', () => {
  const r = runHelper({ lsattr: 'missing' })
  assert.notEqual(r.code, 0, r.out); assert.match(r.out, /lsattr.*not found/)
})
test('fails closed when lsattr cannot read the flags (unsupported filesystem)', () => {
  const r = runHelper({ lsattr: 'fail' })
  assert.notEqual(r.code, 0, r.out); assert.match(r.out, /cannot read the attributes/)
})
test('fails closed when chattr reports success but the flag is absent on read-back', () => {
  const r = runHelper({ chattr: 'noop' })
  assert.notEqual(r.code, 0, r.out); assert.match(r.out, /NOT append-only after chattr \+a/)
})
test('succeeds when chattr +a sets the flag and lsattr reads it back', () => {
  const r = runHelper({})
  assert.equal(r.code, 0, r.out); assert.match(r.out, /set the deletion ledger .* append-only/)
})
test('succeeds without calling chattr when the flag is already set', () => {
  const r = runHelper({ chattr: 'fail', startFlags: '-----a--------e-------' })
  assert.equal(r.code, 0, r.out); assert.match(r.out, /already append-only/)
})

test('install-prod sources the helper and dies (before any unit) when protection is not proved', () => {
  const at = install.indexOf('ensure_ledger_append_only "$LEDGER"')
  assert.ok(at > 0, 'the installer calls the helper on the real ledger')
  assert.match(install.slice(at, at + 200), /\|\| die /)
  assert.ok(install.indexOf('source "$HERE/ledger-append-only.sh"') > 0)
  assert.ok(install.indexOf('created the empty deletion ledger') < at)
  assert.ok(at < install.indexOf('unit dazl-backup.service'))
  assert.equal(spawnSync('bash', ['-n', `${repo}ops/backup/install-prod.sh`]).status, 0)
})

test('the app only ever appends to the ledger, so the append-only flag never blocks a deletion', () => {
  const opens = [...ledger.matchAll(/openSync\([^)]*\)/g)].map(m => m[0])
  assert.ok(opens.length > 0)
  for (const o of opens) assert.match(o, /, 'a', /, `ledger opened for append only: ${o}`)
  assert.doesNotMatch(ledger, /writeFileSync|truncateSync|renameSync|unlinkSync|rmSync/)
})

// Real-filesystem proof: runs only where the runner has passwordless sudo and a filesystem that supports chattr
// (GitHub's ubuntu runners do); it skips with the reason anywhere else. The test user owns the file, as the app user
// does in prod; root sets +a with the real helper; then the owner can append and fsync but not rewrite, truncate,
// rename or delete.
function realFsSkip(): string | false {
  if (process.platform !== 'linux') return 'not Linux'
  if (spawnSync('sudo', ['-n', 'true']).status !== 0) return 'no passwordless sudo (needs root to set +a)'
  if (spawnSync('bash', ['-c', 'command -v chattr && command -v lsattr']).status !== 0) return 'chattr/lsattr not installed'
  const d = mkdtempSync(join(tmpdir(), 'ledger1089-probe-')); const p = join(d, 'x'); writeFileSync(p, '')
  const ok = spawnSync('sudo', ['-n', 'chattr', '+a', p]).status === 0
  spawnSync('sudo', ['-n', 'chattr', '-a', p]); rmSync(d, { recursive: true, force: true })
  return ok ? false : `filesystem under ${tmpdir()} does not support the append-only attribute`
}
const skip = realFsSkip()
test('real Linux fs: owner can append+fsync, but not rewrite/truncate/rename/unlink the +a ledger', { skip }, () => {
  const d = mkdtempSync(join(tmpdir(), 'ledger1089-real-')); const p = join(d, 'tombstones.jsonl')
  writeFileSync(p, '{"n":1}\n')
  try {
    const r = spawnSync('sudo', ['-n', 'bash', '-c', `source '${helper}' && ensure_ledger_append_only '${p}'`], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
    const fd = openSync(p, 'a'); writeSync(fd, '{"n":2}\n'); fsyncSync(fd); closeSync(fd)
    assert.equal(readFileSync(p, 'utf8'), '{"n":1}\n{"n":2}\n')
    assert.throws(() => openSync(p, 'w'), /EPERM/)
    assert.throws(() => openSync(p, 'r+'), /EPERM/)
    assert.throws(() => truncateSync(p, 0), /EPERM/)
    assert.throws(() => renameSync(p, `${p}.x`), /EPERM/)
    assert.throws(() => unlinkSync(p), /EPERM/)
    assert.ok(existsSync(p)); assert.equal(readFileSync(p, 'utf8'), '{"n":1}\n{"n":2}\n')
  } finally {
    spawnSync('sudo', ['-n', 'chattr', '-a', p]); rmSync(d, { recursive: true, force: true })
  }
})
