// #1089 acceptance 2: the deletion ledger must be append-only, yet the app (not root) writes it. Both hold together:
// the app user owns the file and only ever opens it for append, and ops/backup/install-prod.sh sets the kernel's
// append-only flag (chattr +a), which lets an append through and refuses any rewrite, truncation or delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const install = readFileSync(`${repo}ops/backup/install-prod.sh`, 'utf8')
const ledger = readFileSync(`${repo}web/lib/tenant/ledger.ts`, 'utf8')

test('install-prod sets the ledger append-only on the box, and never under --root', () => {
  const block = install.slice(install.indexOf('# append-only (#1089)'))
  assert.ok(block.length < install.length, 'the append-only step is present')
  assert.match(block, /if \[ -z "\$ROOT" \]; then/)
  assert.match(block, /chattr \+a -- "\$LEDGER"/)
  // it runs after the ledger exists and before the units are installed
  assert.ok(install.indexOf('created the empty deletion ledger') < install.indexOf('# append-only (#1089)'))
  assert.ok(install.indexOf('# append-only (#1089)') < install.indexOf('unit dazl-backup.service'))
  assert.equal(spawnSync('bash', ['-n', `${repo}ops/backup/install-prod.sh`]).status, 0)
})

test('the app only ever appends to the ledger, so the append-only flag never blocks a deletion', () => {
  const opens = [...ledger.matchAll(/openSync\([^)]*\)/g)].map(m => m[0])
  assert.ok(opens.length > 0)
  for (const o of opens) assert.match(o, /, 'a', /, `ledger opened for append only: ${o}`)
  assert.doesNotMatch(ledger, /writeFileSync|truncateSync|renameSync|unlinkSync|rmSync/)
})
