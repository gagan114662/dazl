// ops/staging/pull-prebuilt.sh --dry-run, offline: git and curl are stubbed on PATH so these run with no network.
// Round-1 council (#1061) found two real issues this covers:
// - manifest fetch used `curl -f`, whose exit 22 means ANY HTTP error >= 400 - 403 (forbidden), 429 (rate limited)
//   and 5xx were silently treated the same as a benign true 404 ("no build published yet"), so a real outage would
//   never alert. Fixed: read the actual status code (`-w '%{http_code}'`) and only 404 is benign.
// - CURRENT_FILES also trusted $ROOT/current-sha, a file inside the service account's own home (#972: root must
//   not trust a file by a name that account controls). Fixed: that path is read only behind an explicit opt-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../ops/staging/pull-prebuilt.sh', import.meta.url))
const SHA = 'a'.repeat(40)

test('pull-prebuilt.sh is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', script]).status, 0)
})

// Builds a scratch rig: a PATH with stub `git` (always reports SHA as main's head) and stub `curl` (serves a fixed
// HTTP status/body for the manifest URL, and records every invocation so a test can assert curl was or wasn't
// asked to download an asset). Returns the dry-run's exit code and combined output.
function rig(curlStatus: number, curlBody = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'pull-prebuilt-'))
  const bin = path.join(dir, 'bin'); mkdirSync(bin)
  const deploy = path.join(dir, 'deploy.sh'); writeFileSync(deploy, '#!/usr/bin/env bash\n'); chmodSync(deploy, 0o755)
  const envFile = path.join(dir, 'env'); writeFileSync(envFile, '')
  const calls = path.join(dir, 'curl-calls.log')
  writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash\necho "${SHA}\trefs/heads/main"\n`); chmodSync(path.join(bin, 'git'), 0o755)
  // Mimics real curl closely enough for this script's two call shapes: with -f, any HTTP status >= 400 is exit 22
  // and the body is NOT written (curl's own real behavior) - this is what makes the OLD code's `st = 22` check
  // conflate every HTTP error with a benign 404. With -w (the fix, no -f), the body is always written and the
  // status code is printed to stdout, exit 0 - a real HTTP response is not a transport failure.
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
echo "$*" >> '${calls}'
out=""; has_f=0; has_w=0
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  [ "\${args[$i]}" = -o ] && out="\${args[$((i+1))]}"
  # -f may arrive combined with other short flags (the real call uses -fsSL): any single-dash token containing f.
  [[ "\${args[$i]}" == -* && "\${args[$i]}" != --* && "\${args[$i]}" == *f* ]] && has_f=1
  [ "\${args[$i]}" = -w ] && has_w=1
done
if [ $has_f = 1 ] && [ ${curlStatus} -ge 400 ]; then exit 22; fi
[ -n "$out" ] && printf '%s' '${curlBody}' > "$out"
[ $has_w = 1 ] && printf '%s' '${curlStatus}'
exit 0
`)
  chmodSync(path.join(bin, 'curl'), 0o755)
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    STAGING_DEPLOY_SH: deploy, STAGING_ENV_FILE: envFile,
    STAGING_PREBUILT_STATE: path.join(dir, 'pstate'), STAGING_ROOT: path.join(dir, 'root'),
    STAGING_BACKUP_DIR: path.join(dir, 'backups'), STAGING_PREBUILT_DIR: path.join(dir, 'dl'),
    STAGING_CURRENT_SHA_FILES: path.join(dir, 'nonexistent-current-sha'),
  } as unknown as NodeJS.ProcessEnv
  const r = spawnSync('bash', [script, '--dry-run'], { encoding: 'utf8', env })
  return { status: r.status, out: r.stdout + r.stderr, calls }
}

test('a true 404 (no build published yet) is still benign: nothing to do, exit 0', () => {
  const r = rig(404, 'Not Found')
  assert.equal(r.status, 0)
  assert.match(r.out, /no prebuilt build published for main .* yet/)
})

test('a 403 (forbidden) is a real failure now, not silently treated as "nothing to do"', () => {
  const r = rig(403, 'Forbidden')
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.out, /nothing to do/)
  assert.match(r.out, /HTTP 403/)
})

test('a 429 (rate limited) and a 5xx are also real failures, not swallowed as benign', () => {
  for (const code of [429, 500, 503]) {
    const r = rig(code, 'x')
    assert.notEqual(r.status, 0, `HTTP ${code}`)
    assert.match(r.out, new RegExp(`HTTP ${code}`))
  }
})

test('a 200 with a malformed manifest fails on the manifest content, not the transport', () => {
  const r = rig(200, 'not json')
  assert.notEqual(r.status, 0)
  assert.match(r.out, /manifest refused/)
})

// The $ROOT/current-sha legacy path (#972: inside the service account's own home) is read only when a box
// explicitly opts in, never by default - checked directly against the script's own CURRENT_FILES line, since
// exercising it end to end would need a real "already live" state the dry-run path above does not build.
test('#972: the legacy $ROOT/current-sha path is gated behind an explicit opt-in, never read by default', () => {
  const src = readFileSync(script, 'utf8')
  assert.match(src, /CURRENT_FILES=\$\{STAGING_CURRENT_SHA_FILES:-\/var\/lib\/dazl-staging-deploy\/current-sha\}/, 'default CURRENT_FILES is the trusted, root-owned path only')
  assert.match(src, /STAGING_TRUST_LEGACY_CURRENT_SHA/, 'the legacy path is added only behind an explicit env opt-in')
})

// End-to-end version of the test above (round-2 council nit): a real $ROOT/current-sha matching main's head, with
// STAGING_CURRENT_SHA_FILES left UNSET so the script's own default applies (the rig() helper above always sets it,
// which short-circuits the opt-in's `-z` check and so can't exercise this). Without the opt-in the file is never
// read; with it, the script does treat main as already live.
function rigLegacyCurrentSha(trustLegacy: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pull-prebuilt-legacy-'))
  const bin = path.join(dir, 'bin'); mkdirSync(bin)
  const deploy = path.join(dir, 'deploy.sh'); writeFileSync(deploy, '#!/usr/bin/env bash\n'); chmodSync(deploy, 0o755)
  const envFile = path.join(dir, 'env'); writeFileSync(envFile, '')
  writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash\necho "${SHA}\trefs/heads/main"\n`); chmodSync(path.join(bin, 'git'), 0o755)
  // curl is never reached in the "already live" case; stub it to fail loudly if it is, so a regression that skips
  // the early-exit shows up as a curl-not-found-ish failure rather than silently passing.
  writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 77\n'); chmodSync(path.join(bin, 'curl'), 0o755)
  const root = path.join(dir, 'root'); mkdirSync(root)
  writeFileSync(path.join(root, 'current-sha'), SHA)
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    STAGING_DEPLOY_SH: deploy, STAGING_ENV_FILE: envFile,
    STAGING_PREBUILT_STATE: path.join(dir, 'pstate'), STAGING_ROOT: root,
    STAGING_BACKUP_DIR: path.join(dir, 'backups'), STAGING_PREBUILT_DIR: path.join(dir, 'dl'),
    ...(trustLegacy ? { STAGING_TRUST_LEGACY_CURRENT_SHA: '1' } : {}),
  } as unknown as NodeJS.ProcessEnv
  const r = spawnSync('bash', [script, '--dry-run'], { encoding: 'utf8', env })
  return { status: r.status, out: r.stdout + r.stderr }
}

test('#972 end-to-end: without the opt-in, a live legacy current-sha is never read - the script proceeds past it', () => {
  const r = rigLegacyCurrentSha(false)
  assert.doesNotMatch(r.out, /already live/, 'the legacy file matches main but must not be trusted by default')
})

test('#972 end-to-end: with STAGING_TRUST_LEGACY_CURRENT_SHA=1, the same legacy file is read and main is seen as live', () => {
  const r = rigLegacyCurrentSha(true)
  assert.equal(r.status, 0)
  assert.match(r.out, /already live/)
})
