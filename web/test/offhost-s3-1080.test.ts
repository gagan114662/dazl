// #1080, the owner-approved plan: encrypted hourly copies to an S3 bucket with an UPLOAD-ONLY key (put + list, no read,
// no delete), and a restore that proves the copy. Nothing here calls AWS:
//   - scripts/backup/s3.mts signs requests exactly as the worked examples in the S3 API reference, and talks to
//     test/helpers/fake-s3.mts, a loopback stand-in that verifies every signature and body hash and refuses reads and deletes;
//   - ops/backup/aws-setup.sh runs against a stand-in `aws` CLI that keeps the bucket and IAM state in a JSON file;
//   - ops/backup/restore-s3.sh restores a locally made encrypted backup of a synthetic database;
//   - ops/backup/install-prod-offhost.sh runs under --root (no systemctl, no apt-get), GNU userland only (the box is Linux).
// Needs age: skipped with the reason when it is missing, a failure when DAZL_REQUIRE_AGE=1 (CI installs it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { fixtureBackup } from './helpers/recovery-fixture.mts'
import { parseS3, signS3 } from '../scripts/backup/s3.mts'
import { openDest } from '../scripts/backup/offhost.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const repo = path.join(web, '..')
const ops = path.join(repo, 'ops/backup')
const hasAge = spawnSync('age', ['--version']).status === 0
if (!hasAge && process.env.DAZL_REQUIRE_AGE === '1') throw new Error('DAZL_REQUIRE_AGE=1 but age is not installed')
const skip = hasAge ? false : 'age is not installed (apt install age)'
// install-prod.sh is written for the box (GNU stat, realpath -m): its end-to-end test runs where those exist
const gnu = spawnSync('stat', ['-c', '%a', '.']).status === 0 && spawnSync('realpath', ['-m', '/nonexistent/x']).status === 0
const T = mkdtempSync(path.join(tmpdir(), 'offhost-s3-'))
const NODE = ['--experimental-strip-types', '--no-warnings']

// the only key the stand-in bucket accepts. Not a real key: AWS's own documentation example.
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE', SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', BUCKET = 'dazl-prod-backups-123456789012'
const DEST = `s3:${BUCKET}/prod`
const s3dir = path.join(T, 's3'), s3log = s3dir + '.log'
let server: ChildProcess | null = null, endpoint = ''
const s3env = () => ({ AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_REGION: 'ca-central-1', S3_ENDPOINT: endpoint, S3_TIMEOUT_S: '20' })
test.before(async () => {
  mkdirSync(s3dir)
  server = spawn(process.execPath, [...NODE, path.join(web, 'test/helpers/fake-s3.mts'), s3dir], { env: { PATH: process.env.PATH!, FAKE_S3_ACCESS_KEY: KEY_ID, FAKE_S3_SECRET: SECRET } as unknown as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'inherit'] })
  endpoint = await new Promise<string>((res, rej) => {
    server!.stdout!.on('data', (b: Buffer) => { const m = /PORT (\d+)/.exec(String(b)); if (m) res(`http://127.0.0.1:${m[1]}`) })
    server!.on('exit', c => rej(new Error(`fake-s3 exited ${c}`)))
  })
})
test.after(() => { server?.kill(); rmSync(T, { recursive: true, force: true }) })

const run = (cmd: string, args: string[], env: Record<string, string> = {}, cwd?: string) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } as unknown as NodeJS.ProcessEnv, timeout: 180_000 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout, stderr: r.stderr }
}
const sh = (script: string, args: string[], env: Record<string, string> = {}) => run('bash', [path.join(ops, script), ...args], env)
const s3cli = (args: string[], env: Record<string, string> = s3env()) => run(process.execPath, [...NODE, path.join(web, 'scripts/backup/s3.mts'), ...args], env)
const objects = () => existsSync(path.join(s3dir, BUCKET, 'prod')) ? readdirSync(path.join(s3dir, BUCKET, 'prod')).sort() : []
const requests = () => existsSync(s3log) ? readFileSync(s3log, 'utf8').trim().split('\n') : []
const mode = (f: string) => (statSync(f).mode & 0o777).toString(8)
const keypair = (name: string) => {
  const id = path.join(T, name); spawnSync('age-keygen', ['-o', id]); chmodSync(id, 0o600)
  return { id, pub: readFileSync(id, 'utf8').match(/public key: (age1\S+)/)![1] }
}

test('s3 signing: the two worked examples of the S3 API reference, to the last hex digit', () => {
  const creds = { accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' }, now = new Date('2013-05-24T00:00:00Z')
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', host = 'examplebucket.s3.amazonaws.com'
  // "GET Bucket (List Objects)" and "GET Bucket Lifecycle" from "Signature Calculations for the Authorization Header"
  assert.match(signS3({ method: 'GET', host, path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: empty, creds, now }).headers.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/)
  const life = signS3({ method: 'GET', host, path: '/', query: { lifecycle: '' }, payloadHash: empty, creds, now })
  assert.equal(life.headers.authorization, `AWS4-HMAC-SHA256 Credential=${KEY_ID}/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543`)
  assert.equal(life.headers['x-amz-date'], '20130524T000000Z')
  // keys and prefixes are RFC 3986 encoded, "/" kept in a path and encoded in a query value
  const odd = signS3({ method: 'PUT', host, path: "/prod/a b(1)'*.age", query: { prefix: 'prod/x y' }, payloadHash: empty, creds, now })
  assert.equal(odd.canonicalPath, '/prod/a%20b%281%29%27%2A.age'); assert.equal(odd.canonicalQuery, 'prefix=prod%2Fx%20y')
})

test('s3 destination: only s3:BUCKET/PREFIX with a plain bucket and prefix is accepted', () => {
  assert.deepEqual(parseS3(DEST), { bucket: BUCKET, prefix: 'prod' }); assert.deepEqual(parseS3(DEST + '/'), { bucket: BUCKET, prefix: 'prod' })
  for (const bad of ['s3:', `s3:${BUCKET}`, `s3:${BUCKET}/`, 's3:Has.Dots/prod', 's3:UPPER/prod', `s3:${BUCKET}/../x`, `s3:${BUCKET}/a b`, `s3://${BUCKET}/prod`, `rclone:x:${BUCKET}`]) assert.throws(() => parseS3(bad), /s3:BUCKET\/PREFIX/, bad)
})

test('s3 put, list and verify: the bytes arrive, listings page, and a wrong key or a changed body is refused without leaking the secret', () => {
  const f = path.join(T, 'blob.bin'); writeFileSync(f, Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251)))
  let r = s3cli(['put', f, DEST, 'dazl-test-blob.age']); assert.equal(r.code, 0, r.out); assert.match(r.stdout, /"type":"s3_put","ok":true,.*"bytes":70000/)
  assert.ok(readFileSync(path.join(s3dir, BUCKET, 'prod/dazl-test-blob.age')).equals(readFileSync(f)), 'the stored object is the file')
  for (let i = 0; i < 6; i++) assert.equal(s3cli(['put', f, DEST, `dazl-page-${i}.age`]).code, 0)
  r = s3cli(['list', DEST]); assert.equal(r.code, 0, r.out)
  const listed = JSON.parse(r.stdout) as { name: string; size: number; lastModified: string }[]
  assert.deepEqual(listed.map(o => o.name).sort(), objects(), 'all 7 objects, across three pages of 3')
  assert.ok(listed.every(o => o.size === 70_000 && !Number.isNaN(Date.parse(o.lastModified))))
  assert.deepEqual((JSON.parse(s3cli(['list', DEST, 'dazl-page-']).stdout) as { name: string }[]).length, 6, 'a name prefix narrows the listing')
  assert.equal(s3cli(['verify', DEST, 'dazl-test-blob.age', '70000']).code, 0)
  r = s3cli(['verify', DEST, 'dazl-test-blob.age', '69999']); assert.equal(r.code, 1); assert.match(r.out, /listed with 70000 bytes, 69999 were sent/)
  r = s3cli(['verify', DEST, 'dazl-not-there.age', '1']); assert.equal(r.code, 1); assert.match(r.out, /not in the listing/)

  // refused: another secret, a prefix outside the policy, no credentials, a destination that is not s3:BUCKET/PREFIX
  r = s3cli(['put', f, DEST, 'x.age'], { ...s3env(), AWS_SECRET_ACCESS_KEY: 'not-the-secret-not-the-secret-0000000000' }); assert.equal(r.code, 1); assert.match(r.out, /s3 put failed \(HTTP 403 SignatureDoesNotMatch\)/)
  assert.ok(!r.out.includes('not-the-secret') && !r.out.includes(KEY_ID), 'an error names the status and code only')
  r = s3cli(['put', f, `s3:${BUCKET}/elsewhere`, 'x.age']); assert.equal(r.code, 1); assert.match(r.out, /HTTP 403 AccessDenied/)
  r = s3cli(['list', DEST], { S3_ENDPOINT: endpoint }); assert.equal(r.code, 1); assert.match(r.out, /S3 credentials not set \(AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION\)/)
  r = s3cli(['put', f, DEST, '../escape']); assert.equal(r.code, 1); assert.match(r.out, /refused file name/)
  r = s3cli(['list', DEST], { ...s3env(), S3_ENDPOINT: 'http://example.com' }); assert.equal(r.code, 1); assert.match(r.out, /S3_ENDPOINT must be https, or http on loopback/)
  r = s3cli(['list', DEST], { ...s3env(), S3_ENDPOINT: 'http://127.0.0.1:9' }); assert.equal(r.code, 1); assert.match(r.out, /s3 list failed \(no answer from the endpoint\)/)
  assert.equal(s3cli(['get', DEST, 'x']).code, 2, 'there is no get and no delete command')
  assert.ok(!existsSync(path.join(s3dir, BUCKET, 'prod/x.age')) && !existsSync(path.join(s3dir, BUCKET, 'elsewhere')))

  // the recovery tools' view of it: list and put work; read, fetch and remove are refused before any request is made
  const before = requests().length
  const saved = { ...process.env }; Object.assign(process.env, s3env())
  try {
    const dest = openDest(DEST); assert.equal(dest.writeOnly, true); assert.equal(dest.label, `s3:${BUCKET}`)
    assert.deepEqual(dest.list().sort(), objects())
    for (const op of [() => dest.read('dazl-test-blob.age'), () => dest.fetch('dazl-test-blob.age', path.join(T, 'no')), () => dest.remove('dazl-test-blob.age')]) assert.throws(op, /write-only by design/)
  } finally { for (const k of Object.keys(s3env())) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
  assert.ok(requests().slice(before).every(l => l.startsWith('GET /' + BUCKET + '/?')), 'only listings were requested')
  for (const f2 of objects()) rmSync(path.join(s3dir, BUCKET, 'prod', f2))
})

test('hourly job to s3: only ciphertext is uploaded, nothing is read back or deleted, the check judges the listing, and restore-s3.sh restores it', { skip }, async () => {
  const fx = await fixtureBackup(path.join(T, 'fx'))
  const { id, pub } = keypair('identity.txt')
  const recipients = path.join(T, 'recipients.txt'); writeFileSync(recipients, pub + '\n')
  const ledger = path.join(T, 'ledger.jsonl'); writeFileSync(ledger, '{"tenant":"t1","at":"2026-01-01T00:00:00Z"}\n')
  const backups = path.join(T, 'backups'); mkdirSync(backups)
  const jobEnv = { ...s3env(), DB_PATH: fx.source, BACKUP_DIR: backups, WEB_DIR: web.replace(/\/$/, ''), OFFHOST_DEST: DEST, OFFHOST_REQUIRED: '1', OFFHOST_AGE_RECIPIENTS: recipients, DAZL_TOMBSTONE_LEDGER: ledger, BACKUP_RETENTION: '1', RETAIN_LOCAL: '1' }
  const before = requests().length

  let r = sh('run-backup.sh', [], jobEnv); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /"type":"offhost_copy","ok":true,"to":"s3:dazl-prod-backups-123456789012\/prod\/dazl-backup-[^"]+\.db\.age"/); assert.match(r.out, /"type":"backup","ok":true,.*"offhost":true/)
  assert.match(r.out, /"pruned_by":"the bucket lifecycle rule \(this key cannot delete\)"/)
  const local = readdirSync(backups).filter(f => f.endsWith('.db'))[0]
  assert.deepEqual(objects().filter(f => f.startsWith('dazl-backup-')), [`${local}.age`, `${local}.age.json`])
  assert.equal(objects().filter(f => /^dazl-ledger-\d{8}T\d{6}Z\.jsonl\.age(\.json)?$/.test(f)).length, 2, 'the deletion ledger copy and its manifest')
  for (const f of objects()) assert.ok(!readFileSync(path.join(s3dir, BUCKET, 'prod', f)).includes('SQLite format 3'), `${f} holds no plaintext database`)
  assert.ok(readFileSync(path.join(s3dir, BUCKET, 'prod', `${local}.age`)).subarray(0, 21).toString().startsWith('age-encryption.org/v1'))
  // write-only on the wire: uploads and listings, never a read of an object, never a delete
  const made = requests().slice(before)
  assert.ok(made.length >= 6 && made.every(l => /^PUT \/dazl-prod-backups-123456789012\/prod\/dazl-[A-Za-z0-9._-]+$/.test(l) || /^GET \/dazl-prod-backups-123456789012\/\?/.test(l)), made.join('\n'))
  assert.ok(!r.out.includes(SECRET), 'the secret is in no output')

  // a second run: retention keeps RETAIN_LOCAL=1 locally and deletes NOTHING in the bucket (the lifecycle rule does that)
  await new Promise(res => setTimeout(res, 1100))
  r = sh('run-backup.sh', [], jobEnv); assert.equal(r.code, 0, r.out)
  assert.equal(readdirSync(backups).filter(f => f.endsWith('.db')).length, 1); assert.equal(objects().filter(f => f.endsWith('.db.age')).length, 2)
  assert.ok(requests().every(l => !l.startsWith('DELETE')))
  const newest = readdirSync(backups).filter(f => f.endsWith('.db'))[0]

  // the freshness check, from the listing alone
  const check = (env: Record<string, string> = {}, args: string[] = []) => run(process.execPath, [...NODE, 'scripts/backup/backup-check.mts', '--dir', backups, ...args], { ...jobEnv, BACKUP_ALERT_EVERY_S: '0', ...env }, web)
  r = check(); assert.equal(r.code, 0, r.out)
  const body = JSON.parse(r.stdout.trim().split('\n').pop()!)
  assert.deepEqual([body.ok, body.offhost, body.newest_offhost, body.newest_offhost_listed, body.offhost_copies], [true, `s3:${BUCKET}`, `${newest}.age`, true, 2])
  assert.ok(body.newest_offhost_age_s <= 60 && body.newest_offhost_ledger_age_s <= 60)
  const obj = (f: string) => path.join(s3dir, BUCKET, 'prod', f)
  const problems = (env: Record<string, string> = {}, args: string[] = []) => { const c = check(env, args); assert.equal(c.code, 1, c.out); return (JSON.parse(c.stdout.trim().split('\n').pop()!).problems as string[]).join(' | ') }
  // older than 2 hours: every object's LastModified is 3 hours ago
  const old = new Date(Date.now() - 3 * 3600_000); for (const f of objects()) utimesSync(obj(f), old, old)
  assert.match(problems(), /newest off-host copy is 10[89]\d\ds old \(limit 7200s\)/)
  const fresh = new Date(); for (const f of objects()) utimesSync(obj(f), fresh, fresh)
  assert.equal(check().code, 0)
  // a copy cut short, a copy without its manifest, a ledger copy older than the backup copy, an unreachable bucket
  const whole = readFileSync(obj(`${newest}.age`))
  writeFileSync(obj(`${newest}.age`), whole.subarray(0, 1000)); assert.match(problems(), /has 1000 bytes, fewer than the backup it is a copy of \(truncated\)/)
  writeFileSync(obj(`${newest}.age`), whole)
  const manifest = readFileSync(obj(`${newest}.age.json`)); rmSync(obj(`${newest}.age.json`)); assert.match(problems(), /has no manifest next to it/); writeFileSync(obj(`${newest}.age.json`), manifest)
  const hour = new Date(Date.now() - 3600_000); for (const f of objects().filter(x => x.startsWith('dazl-ledger-'))) utimesSync(obj(f), hour, hour)
  assert.match(problems(), /newest off-host ledger copy is older than the newest off-host backup copy/)
  for (const f of objects()) utimesSync(obj(f), fresh, fresh)
  const down = problems({ S3_ENDPOINT: 'http://127.0.0.1:9' }); assert.match(down, /off-host destination s3:dazl-prod-backups-123456789012 unreadable: s3 list failed/); assert.ok(!down.includes(SECRET))
  assert.match(problems({ AWS_SECRET_ACCESS_KEY: 'another-secret-another-secret-0000000000' }), /unreadable: s3 list failed \(HTTP 403 SignatureDoesNotMatch\)/)
  assert.equal(check().code, 0)

  // ---- the restore: the newest object, decrypted with the offline identity, is the database, whole
  const copies = path.join(T, 'downloaded'); mkdirSync(copies); for (const f of objects()) copyFileSync(obj(f), path.join(copies, f))
  const out = path.join(T, 'restored')
  r = sh('restore-s3.sh', ['--from-dir', copies, '--identity', id, '--out', out]); assert.equal(r.code, 0, r.out)
  for (const step of ['find', 'check', 'decrypt', 'ledger', 'verify']) assert.match(r.out, new RegExp(`^PASS  ${step}: `, 'm'))
  assert.match(r.out, /PRAGMA integrity_check ok; rows: users \d+, scan_jobs \d+, leads \d+/); assert.match(r.out, /ALL PASS\. The restored database is /)
  const restored = path.join(out, newest)
  assert.ok(readFileSync(restored).equals(readFileSync(path.join(backups, newest))), 'byte for byte the snapshot the job took')
  assert.deepEqual([mode(out), mode(restored)], ['700', '600'])
  const db = new Database(restored, { readonly: true }), src = new Database(fx.source, { readonly: true })
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    for (const t of ['users', 'scan_jobs', 'leads']) assert.equal((db.prepare(`select count(*) n from ${t}`).get() as { n: number }).n, (src.prepare(`select count(*) n from ${t}`).get() as { n: number }).n, t)
  } finally { db.close(); src.close() }
  assert.equal(readFileSync(path.join(out, objects().filter(f => /^dazl-ledger-.*\.age$/.test(f)).pop()!.replace(/\.age$/, '')), 'utf8'), readFileSync(ledger, 'utf8'))
  assert.ok(!/AGE-SECRET-KEY/.test(r.out))

  // through the AWS CLI (a stand-in that serves the bucket directory): the same result, read-only calls only
  const bin = fakeAws(), awsLog = path.join(T, 'aws-restore.log')
  const out2 = path.join(T, 'restored-aws')
  r = sh('restore-s3.sh', ['--bucket', BUCKET, '--identity', id, '--out', out2], { PATH: `${bin}:${process.env.PATH}`, FAKE_AWS_STATE: path.join(T, 'unused.json'), FAKE_AWS_LOG: awsLog, FAKE_AWS_OBJECTS: s3dir }); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ALL PASS/); assert.ok(readFileSync(path.join(out2, newest)).equals(readFileSync(path.join(backups, newest))))
  assert.ok(readFileSync(awsLog, 'utf8').trim().split('\n').every(l => /^s3api (list-objects-v2|get-object) /.test(l)), 'the restore only lists and downloads')

  // refused or failed, and no plaintext left behind: an existing --out, an identity others can read, the wrong key, a damaged copy
  r = sh('restore-s3.sh', ['--from-dir', copies, '--identity', id, '--out', out]); assert.equal(r.code, 2); assert.match(r.out, /already exists/)
  chmodSync(id, 0o644); r = sh('restore-s3.sh', ['--from-dir', copies, '--identity', id, '--out', path.join(T, 'r1')]); assert.equal(r.code, 2); assert.match(r.out, /can be read by other users/); chmodSync(id, 0o600)
  const other = keypair('other-identity.txt')
  r = sh('restore-s3.sh', ['--from-dir', copies, '--identity', other.id, '--out', path.join(T, 'r2')]); assert.equal(r.code, 1); assert.match(r.out, /^FAIL  decrypt: /m); assert.ok(!readdirSync(path.join(T, 'r2')).some(f => f.endsWith('.db')))
  const bad = readFileSync(path.join(copies, `${newest}.age`)); bad[bad.length - 5] ^= 0xff; writeFileSync(path.join(copies, `${newest}.age`), bad)
  r = sh('restore-s3.sh', ['--from-dir', copies, '--identity', id, '--out', path.join(T, 'r3')]); assert.equal(r.code, 1); assert.match(r.out, /^FAIL  check: .*does not have the size and sha256/m); assert.ok(!readdirSync(path.join(T, 'r3')).some(f => f.endsWith('.db')))
  r = sh('restore-s3.sh', ['--bucket', BUCKET, '--identity', id, '--out', path.join(T, 'r4'), '--dry-run']); assert.equal(r.code, 0); assert.match(r.out, /aws s3api list-objects-v2 --bucket dazl-prod-backups-123456789012 --prefix prod\/dazl- /); assert.ok(!existsSync(path.join(T, 'r4')))
  assert.equal(sh('restore-s3.sh', ['--identity', id]).code, 2)
})

// ---- a stand-in `aws` CLI: the bucket and IAM state live in $FAKE_AWS_STATE (JSON), every call is logged to $FAKE_AWS_LOG
const NEW_SECRET = 'FAKEsecretFAKEsecretFAKEsecretFAKEsecret'
function fakeAws(): string {
  const bin = path.join(T, 'fake-aws-bin')
  if (existsSync(bin)) return bin
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'aws'), `#!/usr/bin/env python3
import datetime, json, os, shutil, sys
a = sys.argv[1:]
open(os.environ['FAKE_AWS_LOG'], 'a').write(' '.join(a) + '\\n')
sp = os.environ['FAKE_AWS_STATE']
st = json.load(open(sp)) if os.path.exists(sp) else {}
def save(): json.dump(st, open(sp, 'w'))
def opt(n):
    return a[a.index(n) + 1] if n in a else None
def doc(n): return json.load(open(opt(n)[len('file://'):]))
def out(o): print(json.dumps(o))
def fail(code, msg='x'):
    sys.stderr.write('\\nAn error occurred (%s) when calling the %s operation: %s\\n' % (code, a[1], msg)); sys.exit(254)
svc, op = a[0], a[1]
b = st.get('bucket')
if svc == 'sts': out({'UserId': 'AIDAOWNER', 'Account': '123456789012', 'Arn': 'arn:aws:iam::123456789012:user/owner'})
elif svc == 's3api':
    if op == 'head-bucket':
        if b is None: fail('404', 'Not Found')
        if b.get('foreign'): fail('403', 'Forbidden')
    elif op == 'create-bucket': st['bucket'] = {'region': (opt('--create-bucket-configuration') or '=us-east-1').split('=')[1]}; save(); out({'Location': '/x'})
    elif op == 'put-public-access-block': b['pab'] = doc('--public-access-block-configuration'); save()
    elif op == 'put-bucket-encryption': b['enc'] = doc('--server-side-encryption-configuration'); save()
    elif op == 'put-bucket-versioning': b['ver'] = opt('--versioning-configuration').split('=')[1]; save()
    elif op == 'put-bucket-lifecycle-configuration': b['life'] = doc('--lifecycle-configuration'); save()
    elif op == 'get-bucket-versioning' and b.get('deny_reads'): fail('AccessDenied', 'Access Denied')
    elif op == 'get-bucket-location': out({'LocationConstraint': b['region']})
    elif op == 'get-public-access-block':
        if not b.get('pab'): fail('NoSuchPublicAccessBlockConfiguration')
        out({'PublicAccessBlockConfiguration': b['pab']})
    elif op == 'get-bucket-encryption':
        if not b.get('enc'): fail('ServerSideEncryptionConfigurationNotFoundError')
        out({'ServerSideEncryptionConfiguration': b['enc']})
    elif op == 'get-bucket-versioning':
        if b.get('ver'): out({'Status': b['ver']})
    elif op == 'get-bucket-lifecycle-configuration':
        if not b.get('life'): fail('NoSuchLifecycleConfiguration')
        out(b['life'])
    elif op == 'list-object-versions':
        if b.get('objects'): out({'Versions': [{'Key': 'prod/x', 'VersionId': '1'}]})
    elif op == 'list-objects-v2':
        d = os.path.join(os.environ['FAKE_AWS_OBJECTS'], opt('--bucket')); pre = opt('--prefix'); items = []
        for root, _, files in os.walk(d):
            for f in files:
                p = os.path.join(root, f); k = os.path.relpath(p, d)
                if k.startswith(pre): items.append({'Key': k, 'Size': os.path.getsize(p), 'LastModified': datetime.datetime.fromtimestamp(os.path.getmtime(p), datetime.timezone.utc).isoformat()})
        out({'Contents': items})
    elif op == 'get-object': shutil.copyfile(os.path.join(os.environ['FAKE_AWS_OBJECTS'], opt('--bucket'), opt('--key')), a[-1]); out({'ContentLength': 1})
    else: sys.stderr.write('fake aws: unknown s3api ' + op + '\\n'); sys.exit(2)
elif svc == 'iam':
    u = st.get('user')
    if op == 'get-user':
        if u is None: fail('NoSuchEntity')
        out({'User': {'UserName': opt('--user-name')}})
    elif op == 'create-user': st['user'] = {'policies': {}, 'attached': [], 'keys': []}; save(); out({'User': {}})
    elif op == 'put-user-policy': u['policies'][opt('--policy-name')] = doc('--policy-document'); save()
    elif op == 'list-user-policies': out({'PolicyNames': sorted(u['policies'])})
    elif op == 'list-attached-user-policies': out({'AttachedPolicies': [{'PolicyName': p} for p in u.get('attached', [])]})
    elif op == 'list-groups-for-user': out({'Groups': []})
    elif op == 'list-access-keys': out({'AccessKeyMetadata': [{'AccessKeyId': k, 'Status': 'Active'} for k in u['keys']]})
    elif op == 'create-access-key':
        k = 'AKIAFAKE%012d' % (len(u['keys']) + 1); u['keys'].append(k); save()
        out({'AccessKey': {'UserName': 'u', 'AccessKeyId': k, 'Status': 'Active', 'SecretAccessKey': '${NEW_SECRET}'}})
    else: sys.stderr.write('fake aws: unknown iam ' + op + '\\n'); sys.exit(2)
else: sys.stderr.write('fake aws: unknown service\\n'); sys.exit(2)
`)
  chmodSync(path.join(bin, 'aws'), 0o755)
  return bin
}

test('aws-setup.sh: the dry run makes no call; a first run makes the bucket, the upload-only user and one key; a second run changes nothing', { skip }, () => {
  const bin = fakeAws(), state = path.join(T, 'aws-state.json'), log = path.join(T, 'aws.log'), keys = path.join(T, 'keys')
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_AWS_STATE: state, FAKE_AWS_LOG: log }
  const setup = (args: string[] = []) => sh('aws-setup.sh', ['--out', keys, ...args], env)
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
  const st = () => JSON.parse(readFileSync(state, 'utf8'))

  // usage
  for (const [args, re] of [[['--region'], /--region needs a value/], [['--nope'], /unknown option/], [['a-bucket', 'b-bucket'], /one bucket name only/], [['Has.Dots'], /3-63 lowercase letters, digits and hyphens/], [['--prefix', 'a/b'], /--prefix must be one plain name/], [['--region', 'canada'], /not a region name/]] as [string[], RegExp][]) {
    const r = setup(args); assert.equal(r.code, 2, r.out); assert.match(r.out, re)
  }
  // dry run: every call printed, none made, nothing written, and the policy is exactly put + list on this bucket
  let r = setup(['--dry-run']); assert.equal(r.code, 0, r.out)
  assert.deepEqual(calls(), [], 'the AWS CLI was not called'); assert.ok(!existsSync(keys) && !existsSync(state))
  for (const c of ['sts get-caller-identity', 's3api create-bucket --bucket dazl-prod-backups-ACCOUNT_ID --region ca-central-1 --create-bucket-configuration LocationConstraint=ca-central-1', 's3api put-public-access-block', 's3api put-bucket-encryption', 's3api put-bucket-versioning --bucket dazl-prod-backups-ACCOUNT_ID --versioning-configuration Status=Enabled', 's3api put-bucket-lifecycle-configuration', 'iam create-user --user-name dazl-backup-writer', 'iam put-user-policy', 'iam create-access-key']) assert.ok(r.stdout.includes('  aws ' + c), c)
  const printed = (name: string) => JSON.parse(r.stdout.split(`--- ${name}.json\n`)[1].split('\n--- ')[0])
  const policy = printed('policy')
  assert.deepEqual(policy.Statement.map((s: { Effect: string; Action: string; Resource: string }) => [s.Effect, s.Action, s.Resource]), [['Allow', 's3:PutObject', 'arn:aws:s3:::dazl-prod-backups-ACCOUNT_ID/prod/*'], ['Allow', 's3:ListBucket', 'arn:aws:s3:::dazl-prod-backups-ACCOUNT_ID']])
  assert.deepEqual(policy.Statement[1].Condition, { StringLike: { 's3:prefix': ['prod/*'] } })
  assert.equal(policy.Statement.length, 2, 'put and list, nothing else: no read, no delete')
  const life = printed('lifecycle').Rules; assert.equal(life.length, 1)
  assert.deepEqual([life[0].Status, life[0].Expiration, life[0].NoncurrentVersionExpiration, life[0].Filter], ['Enabled', { Days: 30 }, { NoncurrentDays: 30 }, { Prefix: '' }])
  assert.deepEqual(printed('public-access-block'), { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true })
  assert.equal(printed('encryption').Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm, 'AES256')

  // not a terminal and no --yes: it asks nothing and changes nothing
  r = setup(); assert.equal(r.code, 2, r.out); assert.match(r.out, /pass --yes/); assert.deepEqual(calls(), ['sts get-caller-identity --output json'])

  // the first real run
  r = setup(['--yes']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /AWS account 123456789012, signed in as arn:aws:iam::123456789012:user\/owner/)
  assert.match(r.out, /2\. bucket dazl-prod-backups-123456789012: created in ca-central-1; public access blocked, encryption on, versioning on, 30-day lifecycle; all read back/)
  assert.match(r.out, /3\. IAM user dazl-backup-writer: created; its one policy/); assert.match(r.out, /4\. access key AKIAFAKE000000000001: made; its secret is in .*\.s3\.env \(mode 600\) and was not shown/)
  assert.ok(!r.out.includes(NEW_SECRET), 'the secret access key is never printed'); assert.ok(!/AGE-SECRET-KEY/.test(r.out), 'nor the age private key')
  assert.ok(calls().every(c => !c.includes(NEW_SECRET)), 'nor passed as an argument')
  const s = st()
  assert.deepEqual([s.bucket.region, s.bucket.ver, s.bucket.pab.BlockPublicPolicy, s.bucket.enc.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm, s.bucket.life.Rules[0].Expiration.Days], ['ca-central-1', 'Enabled', true, 'AES256', 30])
  assert.deepEqual(Object.keys(s.user.policies), ['dazl-backup-put-only'])
  assert.deepEqual(s.user.policies['dazl-backup-put-only'].Statement.map((x: { Action: string; Resource: string }) => [x.Action, x.Resource]), [['s3:PutObject', `arn:aws:s3:::${BUCKET}/prod/*`], ['s3:ListBucket', `arn:aws:s3:::${BUCKET}`]])
  const credFile = path.join(keys, `${BUCKET}.s3.env`), idFile = path.join(keys, 'dazl-offhost-identity.txt')
  assert.deepEqual([mode(keys), mode(credFile), mode(idFile)], ['700', '600', '600'])
  const cred = Object.fromEntries(readFileSync(credFile, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const pub = spawnSync('age-keygen', ['-y', idFile], { encoding: 'utf8' }).stdout.trim()
  assert.deepEqual(cred, { AWS_ACCESS_KEY_ID: 'AKIAFAKE000000000001', AWS_SECRET_ACCESS_KEY: NEW_SECRET, AWS_REGION: 'ca-central-1', DAZL_BACKUP_BUCKET: BUCKET, DAZL_BACKUP_PREFIX: 'prod', DAZL_BACKUP_AGE_RECIPIENT: pub })
  assert.match(r.out, new RegExp(`OFFHOST_DEST=s3:${BUCKET}/prod`)); assert.match(r.out, /install-prod-offhost\.sh" --credentials/)

  // run again: nothing is created, no key is made, the files are the same
  const idBefore = readFileSync(idFile, 'utf8'), credBefore = readFileSync(credFile, 'utf8'), n = calls().length
  r = setup(['--yes']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already exists with exactly these settings: nothing changed/); assert.match(r.out, /already made and already in .*: no new key/); assert.match(r.out, /age key pair: .* already exists: kept/)
  const second = calls().slice(n)
  assert.ok(second.every(c => !/create-bucket|put-bucket|put-public-access-block|create-user|create-access-key/.test(c)), second.join('\n'))
  assert.deepEqual([readFileSync(idFile, 'utf8'), readFileSync(credFile, 'utf8')], [idBefore, credBefore]); assert.ok(!r.out.includes(NEW_SECRET))

  // a bucket that exists with OTHER settings is refused, each difference named, and not one setting is written
  const tamper = (f: (x: ReturnType<typeof st>) => void) => { const x = st(); f(x); writeFileSync(state, JSON.stringify(x)) }
  tamper(x => { x.bucket.ver = 'Suspended'; x.bucket.pab.BlockPublicPolicy = false; x.bucket.life.Rules[0].Expiration.Days = 365; x.bucket.objects = 1 })
  let mark = calls().length
  r = setup(['--yes']); assert.equal(r.code, 1, r.out)
  assert.match(r.out, /already exists with other settings; nothing was changed/); assert.match(r.out, /versioning is Suspended, wanted Enabled/); assert.match(r.out, /Block Public Access is not fully on \(BlockPublicPolicy\)/); assert.match(r.out, /the lifecycle is not the single rule/)
  assert.ok(calls().slice(mark).every(c => /^(sts get-caller-identity|s3api (head-bucket|get-))/.test(c)), 'read-only calls only')
  // even --configure-empty-bucket refuses while it holds objects; an EMPTY one is configured and read back
  r = setup(['--yes', '--configure-empty-bucket']); assert.equal(r.code, 1, r.out); assert.match(r.out, /holds objects: refusing to change it/); assert.equal(st().bucket.ver, 'Suspended')
  tamper(x => { x.bucket.objects = 0 })
  r = setup(['--yes', '--configure-empty-bucket']); assert.equal(r.code, 0, r.out); assert.match(r.out, /existed and was EMPTY: the four settings were applied/); assert.deepEqual([st().bucket.ver, st().bucket.life.Rules[0].Expiration.Days], ['Enabled', 30])
  // other defaults that must be refused: no encryption, a KMS key, another region
  for (const [f, re] of [[(x: ReturnType<typeof st>) => { x.bucket.enc = null }, /default encryption is not set/], [(x: ReturnType<typeof st>) => { x.bucket.enc = { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }] } }, /default encryption is \['aws:kms'\]/], [(x: ReturnType<typeof st>) => { x.bucket.region = 'us-east-2' }, /region is us-east-2, wanted ca-central-1/]] as [(x: ReturnType<typeof st>) => void, RegExp][]) {
    const keep = readFileSync(state, 'utf8'); tamper(f)
    r = setup(['--yes']); assert.equal(r.code, 1, r.out); assert.match(r.out, re); writeFileSync(state, keep)
  }
  // a setting that cannot be READ stops the run: it is neither "fine" nor taken for "not set"
  tamper(x => { x.bucket.deny_reads = true }); mark = calls().length
  r = setup(['--yes']); assert.equal(r.code, 1, r.out); assert.match(r.out, /this AWS call failed: aws s3api get-bucket-versioning/); assert.match(r.out, /settings of bucket .* could not be read/)
  assert.ok(calls().slice(mark).every(c => /^(sts get-caller-identity|s3api (head-bucket|get-))/.test(c)))
  tamper(x => { delete x.bucket.deny_reads })
  // a bucket of that name in another account
  tamper(x => { x.bucket.foreign = true }); mark = calls().length
  r = setup(['--yes']); assert.equal(r.code, 1, r.out); assert.match(r.out, /is not in this account/); assert.ok(calls().slice(mark).every(c => /^(sts|s3api head-bucket)/.test(c)))
  tamper(x => { delete x.bucket.foreign })

  // the user: any other permission is refused; a key this machine has no file for is refused, --new-key makes a second
  tamper(x => { x.user.attached = ['AdministratorAccess'] })
  r = setup(['--yes']); assert.equal(r.code, 1, r.out); assert.match(r.out, /has other permissions \(attached:AdministratorAccess\)/)
  tamper(x => { x.user.attached = []; x.user.policies.extra = {} })
  r = setup(['--yes']); assert.equal(r.code, 1, r.out); assert.match(r.out, /has other permissions \(inline:extra\)/)
  tamper(x => { delete x.user.policies.extra })
  rmSync(credFile)
  r = setup(['--yes']); assert.equal(r.code, 1, r.out); assert.match(r.out, /already has an access key \(AKIAFAKE000000000001\) but .* does not hold it/); assert.ok(!existsSync(credFile))
  r = setup(['--yes', '--new-key']); assert.equal(r.code, 0, r.out); assert.match(r.out, /access key AKIAFAKE000000000002: made/); assert.equal(mode(credFile), '600'); assert.ok(!r.out.includes(NEW_SECRET))
  assert.match(readFileSync(credFile, 'utf8'), /^AWS_ACCESS_KEY_ID=AKIAFAKE000000000002$/m)
  rmSync(credFile); r = setup(['--yes', '--new-key']); assert.equal(r.code, 1, r.out); assert.match(r.out, /already has two access keys/)
})

test('install-prod-offhost.sh: the dry run changes nothing and shows no secret; a credentials file that is incomplete or readable by others is refused', () => {
  const cred = path.join(T, 'box.s3.env'), root = path.join(T, 'dry-root')
  const body = `# SECRET\nAWS_ACCESS_KEY_ID=${KEY_ID}\nAWS_SECRET_ACCESS_KEY=${SECRET}\nAWS_REGION=ca-central-1\nDAZL_BACKUP_BUCKET=${BUCKET}\nDAZL_BACKUP_PREFIX=prod\nDAZL_BACKUP_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqs3290gq\n`
  writeFileSync(cred, body, { mode: 0o600 })
  const appEnv = path.join(T, 'dry-app.env'); writeFileSync(appEnv, 'OPS_ALERT_WEBHOOK_URL=https://alerts.example/hook?token=TOPSECRETTOKEN\n')
  let r = sh('install-prod-offhost.sh', ['--credentials', cred, '--root', root, '--app-env', appEnv, '--dry-run']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /DRY RUN: nothing is installed, written, started or uploaded/); assert.match(r.out, new RegExp(`install-prod\\.sh --offhost s3:${BUCKET}/prod --user ubuntu`))
  assert.match(r.out, /AWS_SECRET_ACCESS_KEY=<from .*, not shown>/); assert.match(r.out, /systemctl enable --now dazl-backup\.timer \(hourly\)/)
  assert.ok(!r.out.includes(SECRET) && !r.out.includes('TOPSECRETTOKEN'), 'neither the key nor the alert URL is printed'); assert.ok(!existsSync(root), 'nothing was written')
  chmodSync(cred, 0o644); r = sh('install-prod-offhost.sh', ['--credentials', cred, '--dry-run']); assert.equal(r.code, 2); assert.match(r.out, /can be read by other users/); chmodSync(cred, 0o600)
  for (const [strip, re] of [['AWS_SECRET_ACCESS_KEY', /no AWS_SECRET_ACCESS_KEY line/], ['DAZL_BACKUP_BUCKET', /no valid DAZL_BACKUP_BUCKET line/], ['DAZL_BACKUP_AGE_RECIPIENT', /no DAZL_BACKUP_AGE_RECIPIENT line/]] as [string, RegExp][]) {
    writeFileSync(cred, body.split('\n').filter(l => !l.startsWith(strip + '=')).join('\n'))
    r = sh('install-prod-offhost.sh', ['--credentials', cred, '--dry-run']); assert.equal(r.code, 1, r.out); assert.match(r.out, re); assert.ok(!r.out.includes(SECRET))
  }
  r = sh('install-prod-offhost.sh', []); assert.equal(r.code, 2); assert.match(r.out, /usage: install-prod-offhost\.sh --credentials FILE/)
  r = sh('install-prod-offhost.sh', ['--credentials', path.join(T, 'nope')]); assert.equal(r.code, 2)
})

test('install-prod-offhost.sh on a stand-in box: key file, timers, one backup now, then PASS for backup, freshness and restore; safe to run again', { skip: skip || (gnu ? false : 'needs GNU stat and realpath -m (the production box is Linux)') }, async () => {
  for (const f of objects()) rmSync(path.join(s3dir, BUCKET, 'prod', f))
  const fx = await fixtureBackup(path.join(T, 'fx-box'))
  const { pub } = keypair('box-identity.txt')
  // the box as the scripts see it: Caddy, the port conf, and a live release that is this checkout
  const root = path.join(T, 'box'), etc = path.join(T, 'box-etc'), ports = path.join(etc, 'ports'), release = path.join(T, 'home', 'dazl-0123abcd-prod')
  mkdirSync(ports, { recursive: true }); mkdirSync(release, { recursive: true })
  symlinkSync(web.replace(/\/$/, ''), path.join(release, 'web')); symlinkSync(path.join(repo, 'ops'), path.join(release, 'ops'))
  const caddy = path.join(etc, 'Caddyfile'); writeFileSync(caddy, 'dazl.ai, www.dazl.ai {\n\tencode gzip\n\treverse_proxy localhost:3105\n}\n'); writeFileSync(path.join(ports, '3105.conf'), `DAZL_RELEASE=${release}\n`)
  const backups = path.join(T, 'box-backups'), ledger = path.join(T, 'box-ledger', 'tombstones.jsonl')
  const appEnv = path.join(T, 'box-app.env'); writeFileSync(appEnv, `DAZL_TOMBSTONE_LEDGER=${ledger}\nOPS_ALERT_WEBHOOK_URL=https://alerts.example/hook?token=TOPSECRETTOKEN\n`)
  mkdirSync(path.dirname(ledger), { recursive: true }); writeFileSync(ledger, '')   // on the box install-prod.sh creates it; under --root it is created inside the root
  const cred = path.join(T, 'box-real.s3.env')
  writeFileSync(cred, `AWS_ACCESS_KEY_ID=${KEY_ID}\nAWS_SECRET_ACCESS_KEY=${SECRET}\nAWS_REGION=ca-central-1\nDAZL_BACKUP_BUCKET=${BUCKET}\nDAZL_BACKUP_PREFIX=prod\nDAZL_BACKUP_AGE_RECIPIENT=${pub}\n`, { mode: 0o600 })
  const env = { LIVE_CADDYFILE: caddy, LIVE_PORTCONF_DIR: ports, S3_ENDPOINT: endpoint }
  // under --root the jobs are run directly and S3_ENDPOINT (the stand-in bucket) is passed through to them
  // under --root the installer writes below the root; the jobs read the real paths, so the test puts the same public key there
  const recipients = path.join(T, 'box-recipients.txt'); writeFileSync(recipients, pub + '\n')
  const args = ['--credentials', cred, '--root', root, '--user', 'appuser', '--db', fx.source, '--backup-dir', backups, '--app-env', appEnv, '--recipients', recipients]
  const go = () => run('bash', [path.join(ops, 'install-prod-offhost.sh'), ...args], env)
  let r = go(); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^PASS {2}backup now/m); assert.match(r.out, /^PASS {2}freshness check: newest object in s3:dazl-prod-backups-123456789012\/prod is dazl-backup-\S+\.db\.age, \d+s old \(limit 7200s\)/m)
  assert.match(r.out, /^PASS {2}restore test: dazl-backup-\S+\.db restored into a temporary file; PRAGMA integrity_check ok, \d+ tables match/m); assert.match(r.out, /ALL PASS/)
  assert.ok(!r.out.includes(SECRET) && !r.out.includes('TOPSECRETTOKEN'), 'no secret in the output')
  const s3envFile = path.join(root, 'etc/dazl-backup/s3.env')
  assert.deepEqual([mode(s3envFile), mode(path.join(root, 'etc/dazl-backup/env'))], ['640', '640'])
  assert.match(readFileSync(s3envFile, 'utf8'), new RegExp(`^AWS_ACCESS_KEY_ID=${KEY_ID}\\nAWS_SECRET_ACCESS_KEY=.+\\nAWS_REGION=ca-central-1$`, 'm'))
  assert.equal(readFileSync(path.join(root, recipients), 'utf8').trim(), pub)
  const envFile = readFileSync(path.join(root, 'etc/dazl-backup/env'), 'utf8')
  assert.match(envFile, new RegExp(`^OFFHOST_DEST=s3:${BUCKET}/prod$`, 'm')); assert.match(envFile, /^OFFHOST_REQUIRED=1$/m); assert.match(envFile, /^OPS_ALERT_WEBHOOK_URL=https:\/\/alerts\.example\/hook\?token=TOPSECRETTOKEN$/m)
  assert.ok(!envFile.includes(SECRET), 'the S3 secret is only in s3.env')
  for (const u of ['dazl-backup.service', 'dazl-backup-check.service']) assert.match(readFileSync(path.join(root, 'etc/systemd/system', u), 'utf8'), /^EnvironmentFile=\/etc\/dazl-backup\/env\nEnvironmentFile=-\/etc\/dazl-backup\/s3\.env$/m)
  assert.equal(objects().filter(f => f.endsWith('.db.age')).length, 1)

  // again: nothing rewritten, one more backup, still all PASS
  r = go(); assert.equal(r.code, 0, r.out); assert.match(r.out, /s3\.env already holds access key .*: unchanged/); assert.match(r.out, /recipients\.txt already holds this public key: unchanged/); assert.match(r.out, /ALL PASS/)
  assert.equal(objects().filter(f => f.endsWith('.db.age')).length, 2)
  // another public key in the credentials file: refused, the recipients file is not changed
  const other = keypair('box-other.txt'); writeFileSync(cred, readFileSync(cred, 'utf8').replace(pub, other.pub))
  r = go(); assert.equal(r.code, 1, r.out); assert.match(r.out, /refusing to change who can decrypt the backups/); assert.equal(readFileSync(path.join(root, recipients), 'utf8').trim(), pub)
  writeFileSync(cred, readFileSync(cred, 'utf8').replace(other.pub, pub))
  // the bucket refuses the key (a revoked or mistyped one): the backup FAILS, loudly, and the script exits 1
  writeFileSync(cred, readFileSync(cred, 'utf8').replace(SECRET, 'revoked-secret-revoked-secret-0000000000'))
  r = go(); assert.equal(r.code, 1, r.out); assert.match(r.out, /^FAIL {2}backup now/m); assert.match(r.out, /NOT DONE: at least one step FAILED/); assert.match(r.out, /HTTP 403 SignatureDoesNotMatch/)
  // a release without the uploader is live: refused before anything is written
  const root2 = path.join(T, 'box2'), old = path.join(T, 'home', 'dazl-89abcdef-prod'); mkdirSync(path.join(old, 'web/scripts/backup'), { recursive: true }); mkdirSync(path.join(old, 'ops/backup'), { recursive: true })
  writeFileSync(path.join(old, 'web/scripts/backup/create-backup.ts'), ''); writeFileSync(path.join(old, 'ops/backup/run-backup.sh'), ''); writeFileSync(path.join(ports, '3105.conf'), `DAZL_RELEASE=${old}\n`)
  r = run('bash', [path.join(ops, 'install-prod-offhost.sh'), ...args.map(a => a === root ? root2 : a)], env); assert.equal(r.code, 1, r.out); assert.match(r.out, /has no web\/scripts\/backup\/s3\.mts: deploy the release/); assert.ok(!existsSync(root2))
})
