// Replacement-host restore drill and key-recovery drill (issue #360; docs/RECOVERY.md "Full-service recovery").
// Rebuilds the service from what survives the loss of the host - the encrypted off-host copies and the separately
// stored keys - into an isolated work directory, times every step, and writes a dated restore report.
//
//   full (default): run on a replacement host built from scratch, isolated (no DNS, not reachable at dazl.ai):
//     node --experimental-strip-types scripts/backup/replacement-drill.mts --offhost "$OFFHOST_DEST" \
//       --identity data-identity.txt --config-identity config-identity.txt --key-file master.key \
//       --work-dir /var/tmp/dazl-replacement-$(date -u +%Y%m%dT%H%M%SZ) --app "$PWD" --report-dir /root/restore-reports \
//       [--manual provision=1800,install=600,dns=300] [--rpo-target-s 3600 --rto-target-s 14400] [--keep-work-dir]
//   keys (--mode keys): the separate key-recovery test. A person other than the one who stored the keys recovers them
//     from their offline stores; this proves each one still opens what it must (and nothing else), without the app:
//     ... --mode keys --report /var/backups/dazl/key-drill-report.json   (backup-check.mts watches this file)
//
// Steps:
//   1. fetch: the newest dazl-backup-* manifest at the destination (tool dazl-offhost-copy, copied_at not in the
//      future), its ciphertext fetched and checked against the manifest's bytes and sha256;
//   2. decrypt: age -d with the DATA identity, the plaintext must hash to the manifest's source_sha256; the
//      create-backup sidecar is recreated from the manifest so the content drill verifies it;
//   3. secrets and config: the newest dazl-config-* bundle, fetched and checked the same way, decrypted with the CONFIG
//      identity, every entry checked against the bundle manifest, master-key lines hold the placeholder and the
//      recovered master key appears in no restored file; the two identities must be different and each must FAIL to
//      open the other's copy (separate key recovery);
//   4. recovery drill: recovery-drill.mts on the decrypted backup with the recovered master key: content, every stored
//      secret decrypted, send-safety counts, and (full) the app started on the restored copy with sending disabled -
//      ready, tick refused, a real password sign-in, scans, leads and key status read, a scan accepted;
//   5. sending: stays disabled; the report says which reconcile counts still block re-enabling it (send-gate.mts).
// Measured RPO = the drill's start minus the restored backup's createdAt (what a host loss at that moment would have
// lost). Measured RTO = this drill's wall time plus the --manual stopwatch seconds of the steps it cannot time
// (provisioning the host, installing the release, switching DNS); without --manual the RTO is reported as incomplete.
// The report holds names, counts, hashes and times: no tenant data, no key material, no secret values. The work
// directory (mode 700, must not exist) is deleted afterwards unless --keep-work-dir.
// Exit 0 = every step and check passed; 1 = a step failed (named in the report); 2 = refused (usage, guards).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDest, plainName, sha256File, type OffhostDest } from './offhost.mts'
import { PLACEHOLDER_VALUE } from './config-placeholder.mts'

const refuse = (why: string): never => { console.error(`replacement-drill: refused: ${why}`); process.exit(2) }
const arg = (f: string) => { const i = process.argv.indexOf(f); if (i < 0) return undefined; const v = process.argv[i + 1]; if (v === undefined || v.startsWith('--')) refuse(`${f} needs a value`); return v }
const mode = arg('--mode') ?? 'full'
if (mode !== 'full' && mode !== 'keys') refuse('--mode is full or keys')
const offSpec = arg('--offhost') ?? (process.env.OFFHOST_DEST?.trim() || undefined)
const identity = arg('--identity'), configIdentity = arg('--config-identity'), keyFile = arg('--key-file'), workArg = arg('--work-dir')
const app = arg('--app'), reportDir = arg('--report-dir'), reportFile = arg('--report'), manualArg = arg('--manual')
const keep = process.argv.includes('--keep-work-dir')
const usage = 'usage: replacement-drill.mts --offhost DEST --identity FILE --config-identity FILE --key-file FILE --work-dir DIR (--app WEB_DIR --report-dir DIR | --mode keys --report FILE) [--manual step=seconds,...] [--rpo-target-s N --rto-target-s N] [--keep-work-dir]'
if (!offSpec || !identity || !configIdentity || !keyFile || !workArg) refuse(usage)
if (mode === 'full' && (!app || !reportDir)) refuse(`full mode needs --app and --report-dir; ${usage}`)
if (mode === 'keys' && !reportFile) refuse(`keys mode needs --report; ${usage}`)
const target = (f: string, env: string) => {
  const v = arg(f) ?? (process.env[env]?.trim() || undefined)
  if (v === undefined) return null
  if (!/^\d+$/.test(v) || Number(v) < 1) refuse(`${f} must be a whole number of seconds >= 1`)
  return Number(v)
}
const rpoTarget = target('--rpo-target-s', 'RPO_TARGET_S'), rtoTarget = target('--rto-target-s', 'RTO_TARGET_S')
const manual: Record<string, number> = {}
if (manualArg !== undefined) {
  for (const part of manualArg.split(',')) {
    const m = /^([a-z][a-z0-9_-]{0,39})=(\d{1,7})$/.exec(part.trim())
    if (!m) refuse(`--manual takes step=seconds pairs (lowercase step names), got ${JSON.stringify(part.slice(0, 60))}`)
    if (m![1] in manual) refuse(`--manual names ${m![1]} twice`)
    manual[m![1]] = Number(m![2])
  }
}
// the recovered keys: each in its own file only its owner can read
const secretFile = (f: string, what: string) => {
  let st
  try { st = statSync(f) } catch { refuse(`${what} ${f} does not exist`) }
  if (!st!.isFile()) refuse(`${what} is not a file`)
  if ((st!.mode & 0o077) !== 0) refuse(`${what} must not be readable by group or others (chmod 600)`)
  return readFileSync(f, 'utf8')
}
const idText = secretFile(identity!, '--identity'), cfgIdText = secretFile(configIdentity!, '--config-identity')
const keyText = secretFile(keyFile!, '--key-file')
if (!/AGE-SECRET-KEY-/.test(idText)) refuse('--identity holds no age identity (AGE-SECRET-KEY-...)')
if (!/AGE-SECRET-KEY-/.test(cfgIdText)) refuse('--config-identity holds no age identity (AGE-SECRET-KEY-...)')
const ids = (t: string) => new Set(t.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('AGE-SECRET-KEY-')))
const shared = [...ids(idText)].filter(k => ids(cfgIdText).has(k))
if (shared.length) refuse('--identity and --config-identity share a key: the data and the secrets must have separate identities')
const master = Buffer.from(keyText.trim(), 'base64')
if (master.length !== 32) refuse('--key-file must hold base64 of exactly 32 bytes')
if (app && !existsSync(path.join(path.resolve(app), '.next/BUILD_ID'))) refuse(`--app ${app} has no production build`)
if (spawnSync('age', ['--version']).status !== 0) refuse('age is not installed (apt install age)')
const work = path.resolve(workArg!)
if (existsSync(work)) refuse(`${work} already exists: the drill only uses a directory it creates`)
for (const v of ['DB_PATH', 'PROD_DB_PATH']) {
  const live = process.env[v]; if (!live) continue
  if ((work + path.sep).startsWith(path.dirname(path.resolve(live)) + path.sep)) refuse(`--work-dir is inside ${v}'s directory`)
}
let dest: OffhostDest
try { dest = openDest(offSpec!) } catch (e) { refuse(e instanceof Error ? e.message : 'bad --offhost') }

type Step = { step: string; ok: boolean; ms: number; detail: Record<string, unknown> }
const steps: Step[] = []
const t0 = Date.now()
const step = async (name: string, f: () => Promise<{ ok: boolean; detail: Record<string, unknown> }> | { ok: boolean; detail: Record<string, unknown> }) => {
  const s = Date.now()
  try { const r = await f(); steps.push({ step: name, ok: r.ok, ms: Date.now() - s, detail: r.detail }); return r.ok }
  catch (e) { steps.push({ step: name, ok: false, ms: Date.now() - s, detail: { error: e instanceof Error ? e.message.slice(0, 200) : 'error' } }); return false }
}
mkdirSync(work, { recursive: false, mode: 0o700 })
const age = (args: string[]) => spawnSync('age', args, { encoding: 'utf8', timeout: 600_000 })

type Manifest = Record<string, unknown> & { ciphertext: string; ciphertext_sha256: string; bytes: number; copied_at: string }
// the newest manifest of one tool at the destination; any listed manifest that does not parse is a problem, never a
// silent fallback to an older copy
function newest(prefix: string, tool: string): { m: Manifest; name: string; listed: number; problems: string[] } {
  const names = dest!.list().filter(f => f.startsWith(prefix) && f.endsWith('.age.json') && plainName(f))
  const problems: string[] = []; const found: { m: Manifest; name: string }[] = []
  for (const f of names) {
    let m: Record<string, unknown> | null = null
    try { m = JSON.parse(dest!.read(f)) } catch { problems.push(`${f} unreadable`); continue }
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.tool !== tool) { problems.push(`${f} is not a ${tool} manifest`); continue }
    const t = typeof m.copied_at === 'string' ? Date.parse(m.copied_at) : NaN
    if (!Number.isFinite(t) || t - Date.now() > 300_000) { problems.push(`${f} has no usable copied_at`); continue }
    if (!plainName(m.ciphertext) || !/^[0-9a-f]{64}$/.test(String(m.ciphertext_sha256)) || typeof m.bytes !== 'number' || !Number.isSafeInteger(m.bytes) || m.bytes <= 0) { problems.push(`${f} does not name a ciphertext, its size and its sha256`); continue }
    found.push({ m: m as Manifest, name: f })
  }
  found.sort((a, b) => Date.parse(b.m.copied_at) - Date.parse(a.m.copied_at) || b.name.localeCompare(a.name))
  if (!found.length) throw new Error(`no usable ${prefix}* copy at ${dest!.label}${problems.length ? ` (${problems.slice(0, 3).join('; ')})` : ''}`)
  return { ...found[0], listed: names.length, problems }
}
const fetchChecked = (m: Manifest, dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const to = path.join(dir, m.ciphertext); dest!.fetch(m.ciphertext, to)
  const bytes = statSync(to).size, sha = sha256File(to)
  return { to, bytes, ok: bytes === m.bytes && sha === m.ciphertext_sha256, why: bytes !== m.bytes ? `${bytes} bytes, the manifest says ${m.bytes}` : sha !== m.ciphertext_sha256 ? 'sha256 differs from the manifest' : null }
}

let dataCt: string | null = null, restoredBackup: string | null = null, backupCreatedAt: string | null = null, copyName: string | null = null, copiedAt: string | null = null
let dataManifest: Manifest | null = null
const fetchOk = await step('fetch off-host copy', () => {
  const n = newest('dazl-backup-', 'dazl-offhost-copy'); dataManifest = n.m; copyName = n.m.ciphertext; copiedAt = n.m.copied_at
  const f = fetchChecked(n.m, path.join(work, 'fetched'))
  dataCt = f.to
  return { ok: f.ok, detail: { destination: dest!.label, copy: n.m.ciphertext, copied_at: n.m.copied_at, manifests_listed: n.listed, bytes: f.bytes, ciphertext_verified: f.ok, ...(f.why ? { problem: f.why } : {}), ...(n.problems.length ? { other_manifest_problems: n.problems.slice(0, 5) } : {}) } }
})

const decryptOk = fetchOk && await step('decrypt with the data identity', () => {
  const m = dataManifest!
  if (!plainName(m.source) || !/\.db$/.test(String(m.source))) return { ok: false, detail: { problem: 'the manifest names no source backup' } }
  const src = path.join(work, 'backup'); mkdirSync(src, { mode: 0o700 })
  const out = path.join(src, String(m.source))
  const r = age(['-d', '-i', identity!, '-o', out, dataCt!])
  if (r.status !== 0) return { ok: false, detail: { problem: `age could not decrypt the copy with this identity (exit ${r.status})` } }
  const sha = sha256File(out), matches = sha === m.source_sha256
  backupCreatedAt = typeof m.source_created_at === 'string' && Number.isFinite(Date.parse(m.source_created_at)) ? m.source_created_at : null
  if (matches) {
    writeFileSync(out + '.json', JSON.stringify({ tool: 'dazl-create-backup', sha256: sha, bytes: statSync(out).size, createdAt: backupCreatedAt, recreated_from: 'off-host manifest' }, null, 2) + '\n', { mode: 0o600 })
    restoredBackup = out
  }
  // the separation proof: the CONFIG identity must not open the data copy
  const cross = age(['-d', '-i', configIdentity!, '-o', path.join(work, 'cross-check.db'), dataCt!])
  rmSync(path.join(work, 'cross-check.db'), { force: true })
  return { ok: matches && backupCreatedAt !== null && cross.status !== 0, detail: { plaintext_verified: matches, backup_created_at: backupCreatedAt, config_identity_cannot_open_it: cross.status !== 0 } }
})

const masterB64 = master.toString('base64'), masterHex = master.toString('hex')
await step('secrets and config with the config identity', () => {
  const n = newest('dazl-config-', 'dazl-config-copy'), m = n.m
  const f = fetchChecked(m, path.join(work, 'fetched-config'))
  if (!f.ok) return { ok: false, detail: { bundle: m.ciphertext, problem: f.why } }
  const dir = path.join(work, 'config'); mkdirSync(dir, { mode: 0o700 })
  const tar = path.join(dir, 'bundle.tar')
  const r = age(['-d', '-i', configIdentity!, '-o', tar, f.to])
  if (r.status !== 0) return { ok: false, detail: { bundle: m.ciphertext, problem: `age could not decrypt the bundle with the config identity (exit ${r.status})` } }
  if (sha256File(tar) !== m.bundle_sha256) return { ok: false, detail: { bundle: m.ciphertext, problem: 'decrypted bundle does not match its manifest sha256' } }
  const cross = age(['-d', '-i', identity!, '-o', path.join(work, 'cross-check.tar'), f.to])
  rmSync(path.join(work, 'cross-check.tar'), { force: true })
  // only MANIFEST.json and files/... entries, no absolute paths, no traversal, no links: checked BEFORE extracting
  const list = spawnSync('tar', ['-tvf', 'bundle.tar'], { cwd: dir, encoding: 'utf8' })
  if (list.status !== 0) return { ok: false, detail: { problem: 'the bundle is not a readable tar' } }
  const names = spawnSync('tar', ['-tf', 'bundle.tar'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const badName = names.find(x => x !== 'MANIFEST.json' && !/^files(\/|$)/.test(x) || x.split('/').includes('..') || x.startsWith('/'))
  const link = list.stdout.split('\n').find(l => /^[lhbcp]/.test(l))
  if (badName || link) return { ok: false, detail: { problem: 'the bundle holds an unexpected entry (absolute, traversal or link): not extracted' } }
  if (spawnSync('tar', ['-xf', 'bundle.tar'], { cwd: dir }).status !== 0) return { ok: false, detail: { problem: 'tar could not extract the bundle' } }
  const bm = JSON.parse(readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')) as { files?: { path: string; sha256: string; master_key_lines: number }[] }
  const entries = Array.isArray(bm.files) ? bm.files : []
  const restoredFiles: { path: string; verified: boolean; env_names?: string[]; master_key_placeholder?: boolean }[] = []
  let leaked = false
  for (const e of entries) {
    const rel = path.join(dir, 'files', String(e.path).replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''))
    if (!rel.startsWith(path.join(dir, 'files') + path.sep) || !existsSync(rel)) { restoredFiles.push({ path: String(e.path), verified: false }); continue }
    const body = readFileSync(rel, 'utf8')
    if (body.includes(masterB64) || body.includes(masterHex)) leaked = true
    const names = [...body.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map(x => x[1])
    restoredFiles.push({ path: String(e.path), verified: sha256File(rel) === e.sha256, ...(names.length ? { env_names: names } : {}), ...(e.master_key_lines ? { master_key_placeholder: body.includes(PLACEHOLDER_VALUE) } : {}) })
  }
  const allVerified = entries.length > 0 && restoredFiles.every(x => x.verified) && restoredFiles.every(x => x.master_key_placeholder !== false)
  return { ok: allVerified && !leaked && cross.status !== 0, detail: { bundle: m.ciphertext, copied_at: m.copied_at, files: restoredFiles, master_key_in_bundle: leaked, data_identity_cannot_open_it: cross.status !== 0 } }
})

let drill: Record<string, unknown> & { ok?: boolean; steps?: Step[] } = {}
if (decryptOk && restoredBackup) {
  await step('recovery drill on the restored copy', () => {
    const report = path.join(work, 'recovery-drill.json')
    const keyCopy = path.join(work, 'master.key'); writeFileSync(keyCopy, masterB64 + '\n', { mode: 0o600 })
    const web = fileURLToPath(new URL('../../', import.meta.url))
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(web, 'scripts/backup/recovery-drill.mts'), '--backup', restoredBackup!, '--key-file', keyCopy, '--work-dir', path.join(work, 'drill'), ...(mode === 'full' ? ['--app', path.resolve(app!)] : []), '--report', report], { cwd: web, env, encoding: 'utf8', timeout: 900_000 })
    rmSync(keyCopy, { force: true })
    try { drill = JSON.parse(readFileSync(report, 'utf8')) } catch { return { ok: false, detail: { problem: `recovery-drill wrote no report (exit ${r.status})` } } }
    return { ok: r.status === 0 && drill.ok === true, detail: { exit: r.status, steps: (drill.steps ?? []).map(s => ({ step: s.step, ok: s.ok, ms: s.ms })) } }
  })
}

const ds = (name: string) => (drill.steps ?? []).find(s => s.step.startsWith(name))
const appD = ds('app')?.detail ?? {}, keyD = ds('key recovery')?.detail ?? {}, sendD = ds('send safety')?.detail ?? {}
const blockedBy = ['messages_sending', 'messages_uncertain', 'sequence_steps_unresolved', 'followups_unresolved', 'leases_unexpired_at_drill', 'queue_claims_unexpired'].filter(k => typeof sendD[k] !== 'number' || sendD[k] !== 0)
const cfg = steps.find(s => s.step.startsWith('secrets'))
const dec = steps.find(s => s.step.startsWith('decrypt'))
const checks: Record<string, boolean> = {
  data_copy_restored: !!steps.find(s => s.step.startsWith('fetch'))?.ok && !!dec?.ok,
  config_and_secrets_restored: !!cfg?.ok,
  keys_separate: dec?.detail.config_identity_cannot_open_it === true && cfg?.detail.data_identity_cannot_open_it === true && cfg?.detail.master_key_in_bundle === false,
  decrypt: ds('key recovery')?.ok === true && Number(keyD.total) > 0,
  ...(mode === 'full' ? {
    sign_in: appD.sign_in_status === 200 && appD.signed_in_read_status === 200 && appD.wrong_password_status === 401,
    scan: appD.scan_started_status === 202 && appD.scan_read_back_status === 200,
    read: appD.scans_status === 200 && appD.key_status === 200 && appD.leads_page_status === 200 && Number(appD.leads_read) > 0,
    sending_disabled: appD.tick_status === 404,
  } : {}),
}
const automatedS = Math.round((Date.now() - t0) / 1000)
const manualS = Object.values(manual).reduce((a, b) => a + b, 0)
const rpoS = backupCreatedAt ? Math.max(0, Math.round((t0 - Date.parse(backupCreatedAt)) / 1000)) : null
const rtoS = automatedS + manualS
const startedAt = new Date(t0).toISOString()
const release = (() => {
  if (!app) return null
  const m = path.join(path.resolve(app), '.build-commit')
  if (existsSync(m)) return readFileSync(m, 'utf8').trim().slice(0, 40)
  const g = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(app), encoding: 'utf8' })
  return g.status === 0 ? g.stdout.trim() : null
})()
const ok = steps.length > 0 && steps.every(s => s.ok) && Object.values(checks).every(Boolean) && steps.some(s => s.step.startsWith('recovery drill'))
const report = {
  kind: mode === 'full' ? 'dazl replacement-host restore report' : 'dazl key recovery drill', version: 1, mode,
  date: startedAt.slice(0, 10), started_at: startedAt, host: os.hostname(), release, destination: dest!.label, copy: copyName, copied_at: copiedAt,
  backup_created_at: backupCreatedAt,
  measured: {
    rpo_s: rpoS,
    automated_s: automatedS,
    manual_s: Object.keys(manual).length ? manual : null,
    rto_s: mode === 'full' ? rtoS : null,
    rto_complete: mode === 'full' && Object.keys(manual).length > 0,
    app_ready_ms: typeof appD.ready_ms === 'number' ? appD.ready_ms : null,
  },
  targets: { rpo_s: rpoTarget, rto_s: rtoTarget, rpo_met: rpoTarget === null || rpoS === null ? null : rpoS <= rpoTarget, rto_met: rtoTarget === null || mode !== 'full' ? null : rtoS <= rtoTarget, note: rpoTarget === null || rtoTarget === null ? 'no approved target given (--rpo-target-s / --rto-target-s): met is not judged' : undefined },
  checks,
  sending: mode === 'full' ? { disabled: 'AUTOPILOT_KILL=1, no tick secret, network fence', may_be_enabled: blockedBy.length === 0, blocked_by: blockedBy, next: blockedBy.length ? 'reconcile these (resolveUncertain; wait for the leases to expire), then scripts/backup/send-gate.mts must exit 0' : 'scripts/backup/send-gate.mts on the live restored database must still exit 0 before AUTOPILOT_KILL is removed' } : null,
  ok, steps, recovery_drill: drill.steps ? { ok: drill.ok, rpo_at_drill_s: drill.rpo_at_drill_s, measured_rto_ms: drill.measured_rto_ms, steps: drill.steps } : null,
  work_dir: keep ? work : null,
}
if (!keep) rmSync(work, { recursive: true, force: true })
const json = JSON.stringify(report, null, 2) + '\n'
const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const written: string[] = []
const writeAtomic = (f: string, body: string) => { writeFileSync(f + '.partial', body, { mode: 0o600 }); renameSync(f + '.partial', f); written.push(f) }
if (reportFile) { mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true }); writeAtomic(path.resolve(reportFile), json) }
if (reportDir) {
  mkdirSync(reportDir, { recursive: true, mode: 0o700 })
  writeAtomic(path.join(reportDir, `restore-report-${stamp}.json`), json)
  const yes = (b: boolean | undefined) => b === undefined ? 'n/a' : b ? 'pass' : '**FAIL**'
  const md = [
    `# dazl ${report.kind}, ${report.date}`, '',
    `Result: **${ok ? 'PASS' : 'FAIL'}**. Host \`${report.host}\`, release \`${release ?? 'unknown'}\`, started ${startedAt}.`,
    `Restored copy \`${copyName ?? '-'}\` (backup taken ${backupCreatedAt ?? '?'}, copied off-host ${copiedAt ?? '?'}) from \`${dest!.label}\`.`, '',
    '| measure | value | target |', '|---|---|---|',
    `| RPO (backup age at drill start) | ${rpoS ?? '?'} s | ${rpoTarget ?? 'not approved'} ${report.targets.rpo_met === null ? '' : report.targets.rpo_met ? '(met)' : '(**missed**)'} |`,
    `| RTO (automated ${automatedS} s + manual ${manualS} s) | ${mode === 'full' ? rtoS + ' s' + (report.measured.rto_complete ? '' : ' (manual steps not timed: incomplete)') : 'n/a'} | ${rtoTarget ?? 'not approved'} ${report.targets.rto_met === null ? '' : report.targets.rto_met ? '(met)' : '(**missed**)'} |`,
    ...Object.entries(manual).map(([k, v]) => `| manual: ${k} | ${v} s | |`), '',
    '| check | result |', '|---|---|', ...Object.entries(checks).map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${yes(v)} |`), '',
    '| step | ms | result |', '|---|---|---|', ...steps.map(s => `| ${s.step} | ${s.ms} | ${yes(s.ok)} |`), ...(drill.steps ?? []).map(s => `| &nbsp;&nbsp;drill: ${s.step} | ${s.ms} | ${yes(s.ok)} |`), '',
    ...(report.sending ? [`Sending: disabled (${report.sending.disabled}). ${report.sending.may_be_enabled ? 'Nothing blocks re-enabling it at drill time' : `Blocked by ${report.sending.blocked_by.join(', ')}`}; ${report.sending.next}.`, ''] : []),
    'This report holds names, counts, hashes and times only: no tenant data, keys or secret values.', '',
  ].join('\n')
  writeAtomic(path.join(reportDir, `restore-report-${stamp}.md`), md)
}
for (const s of steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step} (${s.ms} ms)${s.ok ? '' : ' ' + JSON.stringify(s.detail).slice(0, 300)}`)
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'FAIL'} check: ${k}`)
console.log(`${ok ? 'replacement drill passed' : 'REPLACEMENT DRILL FAILED'} (${mode}): RPO ${rpoS ?? '?'} s, automated ${automatedS} s${mode === 'full' ? `, RTO ${rtoS} s${report.measured.rto_complete ? '' : ' (manual steps not timed)'}` : ''}${written.length ? `; report ${written.map(f => path.basename(f)).join(', ')}` : ''}`)
process.exit(ok ? 0 : 1)
