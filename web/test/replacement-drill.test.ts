// The replacement-host restore path for issue #360, on synthetic data (test/helpers/recovery-fixture.mts):
// scripts/backup/config-backup.mts (secrets/config bundle, master key excluded, its own identity),
// scripts/backup/replacement-drill.mts --mode keys (fetch, decrypt, config restore, key recovery, separation proofs),
// and backup-check.mts's new legs (the config bundle, the key-recovery drill report). The full mode with the app is
// test/smoke/replacement-drill.smoke.mjs (needs a production build). Needs age: skipped with the reason when it is
// missing, a failure when DAZL_REQUIRE_AGE=1 (CI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureBackup } from './helpers/recovery-fixture.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const ops = path.join(web, '../ops/backup')
const hasAge = spawnSync('age', ['--version']).status === 0
if (!hasAge && process.env.DAZL_REQUIRE_AGE === '1') throw new Error('DAZL_REQUIRE_AGE=1 but age is not installed')
const skip = hasAge ? false : 'age is not installed (apt install age)'
const T = mkdtempSync(path.join(tmpdir(), 'replacement-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
let n = 0
const baseEnv = () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) })
const node = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', `scripts/backup/${script}`, ...args], { cwd: web, encoding: 'utf8', env: { ...baseEnv(), ...env } as unknown as NodeJS.ProcessEnv, timeout: 120_000 })
  let json: Record<string, unknown> = {}
  for (const l of r.stdout.trim().split('\n').reverse()) { try { json = JSON.parse(l); break } catch { /* not the JSON line */ } }
  return { code: r.status, out: r.stdout + r.stderr, json }
}
const pair = (name: string) => {
  const id = path.join(T, `${name}-identity.txt`), pub = path.join(T, `${name}-recipients.txt`)
  if (!existsSync(id)) { spawnSync('age-keygen', ['-o', id]); chmodSync(id, 0o600) }
  writeFileSync(pub, readFileSync(id, 'utf8').match(/public key: (age1\S+)/)![1] + '\n')
  return { id, pub }
}

// a world after the host is lost: an off-host destination holding an encrypted data copy and a config bundle
async function world(opts: { config?: (dir: string, key: string) => string[] } = {}) {
  const d = path.join(T, `w${++n}`); mkdirSync(d)
  const fx = await fixtureBackup(path.join(d, 'fx'))
  const data = pair('data'), cfg = pair('config')
  const dest = path.join(d, 'offhost'); mkdirSync(dest)
  const copy = spawnSync('bash', [path.join(ops, 'offhost-copy.sh'), fx.backup], { encoding: 'utf8', env: { ...baseEnv(), OFFHOST_AGE_RECIPIENTS: data.pub, OFFHOST_DEST: dest } })
  assert.equal(copy.status, 0, copy.stdout + copy.stderr)
  const etc = path.join(d, 'etc'); mkdirSync(etc)
  const files = opts.config ? opts.config(etc, fx.key) : (() => {
    writeFileSync(path.join(etc, 'env'), `NODE_ENV=production\nDAZL_MASTER_KEY=${fx.key}\nexport DAZL_MASTER_KEY_PREVIOUS="${fx.key.slice(0, 20)}previouskeyvalue=="\nSTRIPE_SECRET_KEY=sk_test_synthetic\n`)
    writeFileSync(path.join(etc, 'Caddyfile'), 'dazl.ai {\n  reverse_proxy 127.0.0.1:3100\n}\n')
    return [path.join(etc, 'env'), path.join(etc, 'Caddyfile')]
  })()
  const cb = node('config-backup.mts', ['--state-dir', path.join(d, 'state')], { CONFIG_FILES: files.join(' '), CONFIG_AGE_RECIPIENTS: cfg.pub, OFFHOST_AGE_RECIPIENTS: data.pub, OFFHOST_DEST: dest })
  return { d, fx, data, cfg, dest, files, cb }
}
const keysDrill = (w: Awaited<ReturnType<typeof world>>, extra: string[] = [], over: Record<string, string> = {}) => {
  const report = path.join(w.d, `key-drill-${++n}.json`)
  const a: Record<string, string> = { '--offhost': w.dest, '--identity': w.data.id, '--config-identity': w.cfg.id, '--key-file': w.fx.keyFile, '--work-dir': path.join(w.d, `work-${n}`), '--report': report, ...over }
  const r = node('replacement-drill.mts', ['--mode', 'keys', ...Object.entries(a).flat(), ...extra])
  return { ...r, report, j: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null }
}

test('config bundle: only ciphertext leaves, the master key is replaced by the placeholder, unchanged content is not re-copied', { skip }, async () => {
  const w = await world()
  assert.equal(w.cb.code, 0, w.cb.out); assert.equal(w.cb.json.master_key, 'excluded')
  const files = readdirSync(w.dest).filter(f => f.startsWith('dazl-config-'))
  assert.equal(files.length, 2)
  for (const f of files) {
    const b = readFileSync(path.join(w.dest, f))
    assert.ok(!b.includes('sk_test_synthetic') && !b.includes(w.fx.key), `${f} holds no secret in the clear`)
  }
  const ct = path.join(w.dest, files.find(f => f.endsWith('.age'))!), out = path.join(w.d, 'b.tar')
  assert.equal(spawnSync('age', ['-d', '-i', w.cfg.id, '-o', out, ct]).status, 0)
  assert.notEqual(spawnSync('age', ['-d', '-i', w.data.id, '-o', out + '2', ct]).status, 0, 'the data identity cannot open the secrets')
  const x = path.join(w.d, 'x'); mkdirSync(x); spawnSync('tar', ['-xf', '../b.tar'], { cwd: x })
  const env = readFileSync(path.join(x, 'files', w.files[0].replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, '')), 'utf8')
  assert.match(env, /^DAZL_MASTER_KEY=__RESTORE_FROM_OFFLINE_KEY_STORE__$/m)
  assert.match(env, /^export DAZL_MASTER_KEY_PREVIOUS=__RESTORE_FROM_OFFLINE_KEY_STORE__$/m)
  assert.ok(!env.includes(w.fx.key) && env.includes('STRIPE_SECRET_KEY=sk_test_synthetic'))
  const again = node('config-backup.mts', ['--state-dir', path.join(w.d, 'state')], { CONFIG_FILES: w.files.join(' '), CONFIG_AGE_RECIPIENTS: w.cfg.pub, OFFHOST_AGE_RECIPIENTS: w.data.pub, OFFHOST_DEST: w.dest })
  assert.equal(again.code, 0); assert.equal(again.json.unchanged, true)
  assert.equal(readdirSync(w.dest).filter(f => f.startsWith('dazl-config-')).length, 2, 'a retry (or a crash before the marker) copies at most once more; unchanged content is skipped')
})

test('config bundle refuses (exit 2, nothing copied): shared or private recipients, missing/dir/huge/relative/duplicate files, an age identity inside', { skip }, async () => {
  const w = await world(); const data = w.data, cfg = w.cfg
  const dest = path.join(w.d, 'refuse-dest'); mkdirSync(dest)
  const env = (o: Record<string, string>) => ({ CONFIG_FILES: w.files.join(' '), CONFIG_AGE_RECIPIENTS: cfg.pub, OFFHOST_AGE_RECIPIENTS: data.pub, OFFHOST_DEST: dest, ...o })
  const big = path.join(w.d, 'big'); writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 97))
  const withId = path.join(w.d, 'with-id'); writeFileSync(withId, readFileSync(data.id))
  const notKey = path.join(w.d, 'not-a-key.txt'); writeFileSync(notKey, 'hello\n')
  const cases: [string, Record<string, string>, RegExp][] = [
    ['shared recipient', { CONFIG_AGE_RECIPIENTS: data.pub }, /shares a key/],
    ['private key as recipient', { CONFIG_AGE_RECIPIENTS: cfg.id }, /private key/],
    ['not an age key', { CONFIG_AGE_RECIPIENTS: notKey }, /not an age public key/],
    ['no recipients file', { CONFIG_AGE_RECIPIENTS: path.join(w.d, 'none') }, /CONFIG_AGE_RECIPIENTS/],
    ['no files', { CONFIG_FILES: '  ' }, /lists no files/],
    ['missing file', { CONFIG_FILES: path.join(w.d, 'gone') }, /does not exist/],
    ['a directory', { CONFIG_FILES: w.d }, /not a regular file/],
    ['huge', { CONFIG_FILES: big }, /larger than 1 MB/],
    ['relative path', { CONFIG_FILES: 'etc/env' }, /not an absolute path/],
    ['duplicate', { CONFIG_FILES: `${w.files[0]} ${w.files[0]}` }, /twice/],
    ['identity inside', { CONFIG_FILES: withId }, /holds an age identity/],
    ['no destination', { OFFHOST_DEST: '' }, /OFFHOST_DEST/],
  ]
  for (const [name, o, re] of cases) {
    const r = node('config-backup.mts', ['--state-dir', path.join(w.d, `st-${name.replace(/\W/g, '')}`)], env(o))
    assert.equal(r.code, 2, `${name}: ${r.out}`); assert.match(r.out, re, name)
  }
  assert.deepEqual(readdirSync(dest), [], 'nothing was copied by any refused run')
})

test('config bundle: a master key value left anywhere else in a file (a comment, another name) fails, nothing copied', { skip }, async () => {
  const w = await world({ config: (etc, key) => { writeFileSync(path.join(etc, 'env'), `DAZL_MASTER_KEY='${key}'\n# old: ${key}\n`); return [path.join(etc, 'env')] } })
  assert.equal(w.cb.code, 1, w.cb.out); assert.match(w.cb.out, /master key value is still present/)
  assert.deepEqual(readdirSync(w.dest).filter(f => f.startsWith('dazl-config-')), [])
})

test('key-recovery drill passes: copy fetched and verified, decrypted by the data identity only, config restored by its own identity, every secret decrypts', { skip }, async () => {
  const w = await world(); assert.equal(w.cb.code, 0, w.cb.out)
  const r = keysDrill(w)
  assert.equal(r.code, 0, r.out); assert.equal(r.j.ok, true); assert.equal(r.j.kind, 'dazl key recovery drill')
  assert.deepEqual(r.j.steps.map((s: { step: string }) => s.step), ['fetch off-host copy', 'decrypt with the data identity', 'secrets and config with the config identity', 'recovery drill on the restored copy'])
  assert.deepEqual(r.j.checks, { data_copy_restored: true, config_and_secrets_restored: true, keys_separate: true, decrypt: true })
  const cfg = r.j.steps[2].detail
  assert.equal(cfg.master_key_in_bundle, false)
  assert.deepEqual(cfg.files.find((f: { path: string }) => f.path.endsWith('env')).env_names, ['NODE_ENV', 'DAZL_MASTER_KEY', 'DAZL_MASTER_KEY_PREVIOUS', 'STRIPE_SECRET_KEY'])
  assert.equal(typeof r.j.measured.rpo_s, 'number'); assert.equal(r.j.measured.rto_s, null)
  const text = readFileSync(r.report, 'utf8')
  for (const secret of [w.fx.key, 'sk_test_synthetic', 'AGE-SECRET-KEY', 'sk-ant']) assert.ok(!text.includes(secret) && !r.out.includes(secret), `report and output never hold ${secret.slice(0, 8)}`)
  assert.equal(existsSync(path.join(w.d, `work-${n}`)), false, 'the restored copy and the decrypted secrets are deleted')
  // the key drill feeds backup-check's key leg
  const chk = node('backup-check.mts', ['--dir', path.dirname(w.fx.backup), '--state-dir', path.join(w.d, 'chk'), '--key-drill-report', r.report], { BACKUP_ALERT_CMD: 'true', OFFHOST_DEST: w.dest, CONFIG_REQUIRED: '1' })
  assert.equal(chk.json.key_drill_ok, true, chk.out); assert.equal(chk.json.config_verified, true)
})

test('key-recovery drill fails, naming the step: wrong master key, wrong data identity, tampered copy, tampered bundle, no bundle', { skip }, async () => {
  const w = await world(); assert.equal(w.cb.code, 0)
  const wrongKey = path.join(w.d, 'wrong.key'); writeFileSync(wrongKey, Buffer.alloc(32, 7).toString('base64'), { mode: 0o600 }); chmodSync(wrongKey, 0o600)
  let r = keysDrill(w, [], { '--key-file': wrongKey })
  assert.equal(r.code, 1); assert.equal(r.j.ok, false); assert.equal(r.j.checks.decrypt, false)
  const other = pair('other')
  r = keysDrill(w, [], { '--identity': other.id })
  assert.equal(r.code, 1); assert.match(JSON.stringify(r.j.steps[1]), /could not decrypt/)
  const ctName = readdirSync(w.dest).find(f => f.startsWith('dazl-backup-') && f.endsWith('.age'))!, ct = path.join(w.dest, ctName), orig = readFileSync(ct)
  const flipped = Buffer.from(orig); flipped[flipped.length - 1] ^= 1; writeFileSync(ct, flipped)
  r = keysDrill(w); assert.equal(r.code, 1); assert.match(JSON.stringify(r.j.steps[0]), /sha256 differs/)
  writeFileSync(ct, orig)
  const bName = readdirSync(w.dest).find(f => f.startsWith('dazl-config-') && f.endsWith('.age'))!, bct = path.join(w.dest, bName), borig = readFileSync(bct)
  writeFileSync(bct, borig.subarray(0, borig.length - 3))
  r = keysDrill(w); assert.equal(r.code, 1); assert.equal(r.j.checks.config_and_secrets_restored, false)
  rmSync(bct); rmSync(bct + '.json')
  r = keysDrill(w); assert.equal(r.code, 1); assert.match(JSON.stringify(r.j.steps[2]), /no usable dazl-config-\* copy/)
})

test('key-recovery drill: malformed or hostile manifests are never used; a bundle with a path-traversal entry is not extracted', { skip }, async () => {
  const w = await world(); assert.equal(w.cb.code, 0)
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const hostile: Record<string, unknown>[] = [
    [] as unknown as Record<string, unknown>, { tool: 'dazl-offhost-copy' }, { tool: 'dazl-offhost-copy', copied_at: future, ciphertext: 'x.age', ciphertext_sha256: 'a'.repeat(64), bytes: 1 },
    { tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: '../../etc/passwd', ciphertext_sha256: 'a'.repeat(64), bytes: 1 },
    { tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: 'x.age', ciphertext_sha256: 'a'.repeat(64), bytes: '1' },
    { tool: 'other', copied_at: new Date().toISOString() },
  ]
  hostile.forEach((m, i) => writeFileSync(path.join(w.dest, `dazl-backup-99990101T00000${i}Z-0000000${i}.db.age.json`), JSON.stringify(m)))
  writeFileSync(path.join(w.dest, 'dazl-backup-99990101T000009Z-00000009.db.age.json'), '{"tool":"dazl-offhost-copy","copied_at":"2026') // truncated
  writeFileSync(path.join(w.dest, 'dazl-backup-99990101T000010Z-0000000a.db.age.json'), Buffer.from([0xff, 0xfe, 0x00, 0x81])) // not UTF-8 JSON
  let r = keysDrill(w)
  assert.equal(r.code, 0, `the genuine copy is still found and used: ${r.out}`)
  assert.ok(r.j.steps[0].detail.other_manifest_problems.length >= 5, JSON.stringify(r.j.steps[0].detail))
  // a malicious bundle (encrypted to the config recipient, a valid manifest) holding ../ and absolute entries
  const evil = path.join(w.d, 'evil'); mkdirSync(path.join(evil, 'files'), { recursive: true }); writeFileSync(path.join(evil, 'MANIFEST.json'), '{"files":[]}'); writeFileSync(path.join(w.d, 'escaped.txt'), 'x')
  spawnSync('tar', ['-cf', 'evil.tar', 'MANIFEST.json', 'files', '../escaped.txt'], { cwd: evil })
  const name = 'dazl-config-29991231T235959Z-eeeeeeee.tar.age'
  spawnSync('age', ['-R', w.cfg.pub, '-o', path.join(w.dest, name), path.join(evil, 'evil.tar')])
  const sha = (f: string) => spawnSync(process.execPath, ['-e', `process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))`, f], { encoding: 'utf8' }).stdout
  writeFileSync(path.join(w.dest, name + '.json'), JSON.stringify({ tool: 'dazl-config-copy', ciphertext: name, ciphertext_sha256: sha(path.join(w.dest, name)), bytes: readFileSync(path.join(w.dest, name)).length, bundle_sha256: sha(path.join(evil, 'evil.tar')), copied_at: new Date(Date.now() + 1000).toISOString() }))
  r = keysDrill(w)
  assert.equal(r.code, 1); assert.match(JSON.stringify(r.j.steps[2]), /unexpected entry/)
})

test('key-recovery drill refuses (exit 2): shared identities, readable key files, an existing work dir, bad --manual or targets, missing args', { skip }, async () => {
  const w = await world()
  const loose = path.join(w.d, 'loose.txt'); writeFileSync(loose, readFileSync(w.data.id)); chmodSync(loose, 0o644)
  const notId = path.join(w.d, 'not-id.txt'); writeFileSync(notId, 'nothing here', { mode: 0o600 }); chmodSync(notId, 0o600)
  const exists = path.join(w.d, 'exists'); mkdirSync(exists)
  const cases: [string, string[], Record<string, string>, RegExp][] = [
    ['same identity twice', [], { '--config-identity': w.data.id }, /share a key/],
    ['readable identity', [], { '--identity': loose }, /chmod 600/],
    ['not an identity', [], { '--config-identity': notId }, /no age identity/],
    ['work dir exists', [], { '--work-dir': exists }, /already exists/],
    ['bad manual', ['--manual', 'provision=ten'], {}, /step=seconds/],
    ['manual twice', ['--manual', 'dns=1,dns=2'], {}, /twice/],
    ['bad target', ['--rpo-target-s', '-5'], {}, /whole number/],
    ['bad mode', ['--mode', 'all'], {}, /full or keys/],
  ]
  for (const [name, extra, over, re] of cases) { const r = keysDrill(w, extra, over); assert.equal(r.code, 2, `${name}: ${r.out}`); assert.match(r.out, re, name); assert.equal(r.j, null, `${name}: no report`) }
  assert.equal(node('replacement-drill.mts', []).code, 2)
  assert.match(node('replacement-drill.mts', ['--offhost', w.dest, '--identity', w.data.id, '--config-identity', w.cfg.id, '--key-file', w.fx.keyFile, '--work-dir', path.join(w.d, 'wf')]).out, /full mode needs --app/)
})

test('backup-check: the key-recovery drill report and the config bundle alert when missing, failed, stale or tampered (original gap: silent)', async () => {
  const fx = await fixtureBackup(path.join(T, `kc${++n}`)), local = path.dirname(fx.backup)
  const chk = (args: string[], env: Record<string, string> = {}) => node('backup-check.mts', ['--dir', local, '--state-dir', path.join(T, `kst-${++n}`), ...args], { BACKUP_ALERT_CMD: 'true', ...env })
  assert.equal(chk([]).code, 0, 'not configured and not required: no new problem')
  let r = chk([], { KEY_DRILL_REQUIRED: '1' }); assert.equal(r.code, 1); assert.match(String(r.json.problems), /key-recovery drill is required/)
  const rep = path.join(T, `kdr-${n}.json`)
  r = chk(['--key-drill-report', rep]); assert.equal(r.code, 1); assert.match(String(r.json.problems), /no readable key-recovery drill report/)
  for (const bad of ['[]', 'null', '"x"', '{"kind":"something else","ok":true}', '{"kind":"dazl key recovery drill","ok":"true","started_at":"' + new Date().toISOString() + '"}']) {
    writeFileSync(rep, bad); r = chk(['--key-drill-report', rep]); assert.equal(r.code, 1, bad)
  }
  writeFileSync(rep, JSON.stringify({ kind: 'dazl key recovery drill', ok: false, started_at: new Date().toISOString(), steps: [{ step: 'decrypt with the data identity', ok: false }] }))
  r = chk(['--key-drill-report', rep]); assert.match(String(r.json.problems), /key-recovery drill FAILED \(decrypt with the data identity\)/)
  writeFileSync(rep, JSON.stringify({ kind: 'dazl key recovery drill', ok: true, started_at: new Date(Date.now() - 100 * 86_400_000).toISOString(), steps: [] }))
  r = chk(['--key-drill-report', rep]); assert.match(String(r.json.problems), /key-recovery drill is \d+s old/)
  writeFileSync(rep, JSON.stringify({ kind: 'dazl key recovery drill', ok: true, started_at: new Date().toISOString(), steps: [] }))
  r = chk([], { KEY_DRILL_REPORT: rep }); assert.equal(r.code, 0, r.out); assert.equal(r.json.key_drill_ok, true)
  // the config leg
  const dest = path.join(T, `kc-dest-${n}`); mkdirSync(dest)
  r = chk([], { OFFHOST_DEST: dest, CONFIG_REQUIRED: '1' }); assert.match(String(r.json.problems), /no secrets\/config bundle/)
  const cn = 'dazl-config-20261103T000000Z-0000abcd.tar.age'
  writeFileSync(path.join(dest, cn + '.json'), JSON.stringify({ tool: 'dazl-config-copy', ciphertext: cn, ciphertext_sha256: '0'.repeat(64), bytes: 3, copied_at: new Date().toISOString() }))
  r = chk([], { OFFHOST_DEST: dest }); assert.match(String(r.json.problems), /bundle .* is missing/)
  writeFileSync(path.join(dest, cn), 'abc'); r = chk([], { OFFHOST_DEST: dest }); assert.match(String(r.json.problems), /does not match its manifest/)
  writeFileSync(path.join(dest, cn + '.json'), '{"tool":"dazl-config-copy"'); r = chk([], { OFFHOST_DEST: dest }); assert.match(String(r.json.problems), /secrets\/config manifest .* unreadable or incomplete/)
})
