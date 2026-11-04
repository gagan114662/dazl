// Encrypted off-host copy of the service's secrets and config (issue #360; docs/RECOVERY.md "Secrets and config").
// A database backup alone does not bring the service back: the env file (Stripe keys, webhook secret, OAuth clients),
// the Caddyfile and the systemd units are needed too. This bundles them, EXCLUDING the master key, encrypts the bundle
// to its OWN age recipients (never the database copies' recipients), and writes it next to the database copies:
//   CONFIG_FILES="/etc/dazl/env /etc/caddy/Caddyfile /etc/systemd/system/dazl.service" \
//   CONFIG_AGE_RECIPIENTS=/etc/dazl-backup/config-recipients.txt OFFHOST_AGE_RECIPIENTS=/etc/dazl-backup/recipients.txt \
//   OFFHOST_DEST=<dir | rclone:REMOTE:PATH> node --experimental-strip-types scripts/backup/config-backup.mts [--state-dir D] [--force]
// Run daily as root by ops/backup/dazl-config-backup.timer (root: the env file is root-owned). Writes
// dazl-config-<ts>.tar.age and its manifest dazl-config-<ts>.tar.age.json (tool dazl-config-copy: file list, plaintext
// and ciphertext sha256, bytes, recipients; no contents) only when the bundle's content differs from the last one
// copied (state file in --state-dir, default /var/lib/dazl-backup), then reads the upload back and compares its hash.
// Fail-closed refusals (exit 2, nothing copied):
//   - a listed file that is missing, not a regular file, or larger than 1 MB; no files; a path with whitespace;
//   - recipients that are missing, hold a private key, or share any key with OFFHOST_AGE_RECIPIENTS (the config bundle
//     holds live secrets: one leaked identity must not open both the data and the secrets);
//   - an age identity (AGE-SECRET-KEY) inside a listed file.
// The master key: every DAZL_MASTER_KEY* assignment is replaced by DAZL_MASTER_KEY...=__RESTORE_FROM_OFFLINE_KEY_STORE__,
// then the staged bundle is searched for each original value; finding one is a failure (exit 1). The master key is
// recovered from its own offline store (docs/RECOVERY.md "Key recovery"), never from a backup.
// Exit 0 copied (or unchanged); 1 failed (encryption, upload, read-back, a key value still present); 2 refused.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDest, sha256File } from './offhost.mts'
import { PLACEHOLDER_VALUE } from './config-placeholder.mts'

const refuse = (why: string): never => { console.error(`config-backup: refused: ${why}`); process.exit(2) }
const fail = (why: string): never => { console.error(`config-backup: FAILED: ${why}`); process.exit(1) }
const arg = (f: string) => { const i = process.argv.indexOf(f); if (i < 0) return undefined; const v = process.argv[i + 1]; if (v === undefined || v.startsWith('--')) refuse(`${f} needs a value`); return v }
const PLACEHOLDER = PLACEHOLDER_VALUE
// DAZL_MASTER_KEY, DAZL_MASTER_KEY_PREVIOUS, ... optionally exported, any spacing around =
const MASTER_LINE = /^(\s*(?:export\s+)?)(DAZL_MASTER_KEY[A-Z0-9_]*)(\s*=\s*)(.*)$/

const files = (process.env.CONFIG_FILES ?? '').split(/\n/).flatMap(l => l.trim().split(/\s+/)).filter(Boolean)
if (!files.length) refuse('CONFIG_FILES lists no files')
if (new Set(files).size !== files.length) refuse('CONFIG_FILES lists a file twice')
const recipients = process.env.CONFIG_AGE_RECIPIENTS, dataRecipients = process.env.OFFHOST_AGE_RECIPIENTS, destSpec = process.env.OFFHOST_DEST?.trim()
if (!recipients || !existsSync(recipients)) refuse('CONFIG_AGE_RECIPIENTS must name a file of age public keys')
const keysIn = (f: string) => readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
const mine = keysIn(recipients!)
if (!mine.length) refuse('CONFIG_AGE_RECIPIENTS is empty')
if (mine.some(k => k.includes('AGE-SECRET-KEY'))) refuse('CONFIG_AGE_RECIPIENTS holds a private key: give it public keys (age1...) only')
if (mine.some(k => !/^age1[0-9a-z]{20,}$/.test(k))) refuse('CONFIG_AGE_RECIPIENTS holds something that is not an age public key')
if (dataRecipients && existsSync(dataRecipients)) {
  const shared = keysIn(dataRecipients).filter(k => mine.includes(k))
  if (shared.length) refuse('CONFIG_AGE_RECIPIENTS shares a key with OFFHOST_AGE_RECIPIENTS: the config bundle needs its own identity')
}
if (!destSpec) refuse('OFFHOST_DEST is not set')
if (spawnSync('age', ['--version']).status !== 0) refuse('age is not installed (apt install age)')

const stage = mkdtempSync(path.join(os.tmpdir(), 'dazl-config-'))
const cleanup = () => rmSync(stage, { recursive: true, force: true })
process.on('exit', cleanup)
const masterValues: string[] = []
const entries: { path: string; sha256: string; bytes: number; master_key_lines: number }[] = []
for (const f of files) {
  if (!path.isAbsolute(f)) refuse(`${f} is not an absolute path`)
  let st
  try { st = lstatSync(f) } catch { refuse(`${f} does not exist`) }
  if (!st!.isFile()) refuse(`${f} is not a regular file`)
  if (st!.size > 1024 * 1024) refuse(`${f} is larger than 1 MB: not a config file`)
  const raw = readFileSync(f)
  const text = raw.toString('utf8')
  if (text.includes('AGE-SECRET-KEY')) refuse(`${f} holds an age identity: identities are never backed up`)
  let n = 0
  const staged = text.split('\n').map(line => {
    const m = MASTER_LINE.exec(line.replace(/\r$/, ''))
    if (!m) return line
    n++
    const v = m[4].trim().replace(/^(['"])(.*)\1$/, '$2')
    if (v && v !== PLACEHOLDER) masterValues.push(v)
    return `${m[1]}${m[2]}${m[3]}${PLACEHOLDER}${line.endsWith('\r') ? '\r' : ''}`
  }).join('\n')
  const rel = path.join('files', f.replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''))
  mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(stage, rel), staged, { mode: 0o600 })
  entries.push({ path: f, sha256: createHash('sha256').update(staged).digest('hex'), bytes: Buffer.byteLength(staged), master_key_lines: n })
}
// the proof the master key is not in the bundle: no original value appears anywhere in what is about to be encrypted
for (const e of entries) {
  const body = readFileSync(path.join(stage, 'files', e.path.replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, '')), 'utf8')
  for (const v of masterValues) if (v.length >= 8 && body.includes(v)) fail(`a master key value is still present in the staged copy of ${e.path}`)
}
entries.sort((a, b) => a.path.localeCompare(b.path))
const content = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
writeFileSync(path.join(stage, 'MANIFEST.json'), JSON.stringify({ tool: 'dazl-config-bundle', version: 1, files: entries, master_key: 'excluded: restore from the offline key store' }, null, 2) + '\n')

const stateDir = arg('--state-dir') ?? '/var/lib/dazl-backup'
const stateFile = path.join(stateDir, 'config-last-sha256')
const last = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : ''
if (last === content && !process.argv.includes('--force')) {
  console.log(JSON.stringify({ level: 'info', type: 'config_copy', ok: true, unchanged: true, content_sha256: content, files: entries.length }))
  process.exit(0)
}

const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const name = `dazl-config-${ts}-${randomBytes(4).toString('hex')}.tar.age`
const tarFile = path.join(stage, 'bundle.tar'), ctFile = path.join(stage, name)
// relative names from inside the stage: a drive-letter path would read as a remote host to GNU tar
const tar = spawnSync('tar', ['-cf', 'bundle.tar', 'MANIFEST.json', 'files'], { cwd: stage, encoding: 'utf8' })
if (tar.status !== 0) fail(`tar failed (exit ${tar.status})`)
const enc = spawnSync('age', ['-R', recipients!, '-o', ctFile, tarFile], { encoding: 'utf8' })
if (enc.status !== 0) fail(`age failed (exit ${enc.status})`)
if (!readFileSync(ctFile).subarray(0, 16).toString('latin1').includes('age-encryption')) fail('age output is not an age file')
const manifest = {
  tool: 'dazl-config-copy', version: 1, ciphertext: name, ciphertext_sha256: sha256File(ctFile), bytes: lstatSync(ctFile).size,
  bundle_sha256: sha256File(tarFile), content_sha256: content, files: entries.map(e => ({ path: e.path, sha256: e.sha256, bytes: e.bytes, master_key_lines: e.master_key_lines })),
  master_key: 'excluded', recipients: mine, host: os.hostname(), copied_at: new Date().toISOString(),
}
writeFileSync(ctFile + '.json', JSON.stringify(manifest, null, 2) + '\n')
let dest
try {
  dest = openDest(destSpec!)
  dest.put(ctFile, name)
  dest.put(ctFile + '.json', name + '.json')
  const back = path.join(stage, 'readback'); dest.fetch(name, back)
  if (sha256File(back) !== manifest.ciphertext_sha256) fail('read-back sha256 of the uploaded bundle differs from what was written')
} catch (e) { fail(`upload: ${e instanceof Error ? e.message : 'error'}`) }
try { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); writeFileSync(stateFile, content + '\n', { mode: 0o600 }) }
catch (e) { console.error(`config-backup: copied, but the change marker was not written (${(e as NodeJS.ErrnoException).code ?? 'error'}); the next run copies again`) }
console.log(JSON.stringify({ level: 'info', type: 'config_copy', ok: true, to: dest!.label, ciphertext: name, ciphertext_sha256: manifest.ciphertext_sha256, files: entries.length, master_key: 'excluded' }))
