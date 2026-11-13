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
  const deploy = trustedDeploy(dir)
  const envFile = path.join(dir, 'env'); writeFileSync(envFile, `DAZL_ENV=staging\nDB_PATH=${path.join(dir, 'app.db')}\n`)
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
    STAGING_STATE_ROOT: path.join(dir, 'state'), STAGING_TRUSTED_UID: String(process.getuid!()),
  } as unknown as NodeJS.ProcessEnv
  const r = spawnSync('bash', [script, '--dry-run'], { encoding: 'utf8', env })
  return { status: r.status, out: r.stdout + r.stderr, calls }
}

// The #908 deploy script stand-in: root-owned in production; here owned by the test user, who stands in for root
// (STAGING_TRUSTED_UID), in a directory writable by its owner only, with deploy.sh's --check-env interface.
function trustedDeploy(dir: string) {
  const lib = path.join(dir, 'lib'); mkdirSync(lib); chmodSync(lib, 0o755)
  const deploy = path.join(lib, 'deploy.sh')
  writeFileSync(deploy, '#!/usr/bin/env bash\n# STAGING_MIGRATE\n[ "${1:-}" = --check-env ] && { echo "env ok"; exit 0; }\n'); chmodSync(deploy, 0o755)
  return deploy
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

// #972 / #1061 review finding 2: deploy.sh records the live commit in its root-owned state directory; the pre-#908
// $ROOT/current-sha, inside the service account's own home, is never read - not even with the old opt-in variable, which
// no longer exists. A legacy file naming main must not make the script treat main as live.
test('#1061: a legacy $ROOT/current-sha naming main is never read (the opt-in is gone); the state root\'s file is', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pull-prebuilt-legacy-'))
  const bin = path.join(dir, 'bin'); mkdirSync(bin)
  const deploy = trustedDeploy(dir)
  const envFile = path.join(dir, 'env'); writeFileSync(envFile, `DAZL_ENV=staging\nDB_PATH=${path.join(dir, 'app.db')}\n`)
  writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash\necho "${SHA}\trefs/heads/main"\n`); chmodSync(path.join(bin, 'git'), 0o755)
  // past the live check the dry run fetches the manifest: a 404 here means "proceeded past the legacy file"
  writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nprintf 404\n'); chmodSync(path.join(bin, 'curl'), 0o755)
  const root = path.join(dir, 'root'); mkdirSync(root)
  writeFileSync(path.join(root, 'current-sha'), SHA)
  const state = path.join(dir, 'state'); mkdirSync(state)
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    STAGING_DEPLOY_SH: deploy, STAGING_ENV_FILE: envFile, STAGING_TRUSTED_UID: String(process.getuid!()),
    STAGING_PREBUILT_STATE: path.join(dir, 'pstate'), STAGING_ROOT: root, STAGING_STATE_ROOT: state,
    STAGING_BACKUP_DIR: path.join(dir, 'backups'), STAGING_PREBUILT_DIR: path.join(dir, 'dl'),
    STAGING_TRUST_LEGACY_CURRENT_SHA: '1',
  } as unknown as NodeJS.ProcessEnv
  let r = spawnSync('bash', [script, '--dry-run'], { encoding: 'utf8', env })
  assert.doesNotMatch(r.stdout + r.stderr, /already live/, 'the legacy file is not trusted, even with the old opt-in')
  assert.match(r.stdout + r.stderr, /no prebuilt build published/)
  writeFileSync(path.join(state, 'current-sha'), SHA)
  r = spawnSync('bash', [script, '--dry-run'], { encoding: 'utf8', env })
  assert.equal(r.status, 0); assert.match(r.stdout, /already live/)
})

// #1061 review finding 8: a same-commit rerun must not replace the archives under a still-visible old manifest. The
// publish step deletes this commit's manifest asset BEFORE uploading the archives, and uploads the manifest last.
test('#1061: the publish step removes the old manifest before replacing the archives, and uploads the manifest last', () => {
  const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/staging-prebuilt.yml', import.meta.url)), 'utf8')
  const step = wf.slice(wf.indexOf('- name: Publish to the staging-prebuilt prerelease'), wf.indexOf('- name: Keep the newest 3'))
  const del = step.search(/gh api -X DELETE "repos\/\$REPO\/releases\/assets\/\$mid"/)
  const archives = step.indexOf('gh release upload "$TAG" -R "$REPO" --clobber "staging-next-$SHA.tgz"')
  const manifest = step.indexOf('gh release upload "$TAG" -R "$REPO" --clobber "staging-prebuilt-$SHA.json"')
  assert.ok(del > 0, 'the old manifest asset is deleted'); assert.ok(archives > 0 && manifest > 0)
  assert.ok(del < archives, 'deleted before the archives are replaced'); assert.ok(archives < manifest, 'the manifest last')
})

// #1061 review (Hermes-PC at 9056ef11), finding 3: "rebuild any commit for a rollback" must hold for commits from before
// ops/prod existed. The workflow's REAL Manifest step is run in a checkout of such a commit (no ops/prod), with the
// tools checkout (.prod-tools, the workflow's own commit) beside it, as on the runner.
test('#1061: the prod Manifest step runs from the workflow\'s own tools checkout, so a pre-ops/prod commit can be rebuilt', () => {
  const wfPath = fileURLToPath(new URL('../../.github/workflows/prod-prebuilt.yml', import.meta.url))
  const wf = readFileSync(wfPath, 'utf8')
  const tools = wf.slice(wf.indexOf('path: .prod-tools') - 200, wf.indexOf('path: .prod-tools') + 100)
  assert.match(tools, /ref: \$\{\{ github\.sha \}\}/, 'the tools come from the workflow\'s own commit')
  const step = wf.slice(wf.indexOf('- name: Manifest'), wf.indexOf('- uses: actions/upload-artifact@v4'))
  const run = step.slice(step.indexOf('run: |') + 'run: |'.length).split('\n').filter(l => l.trim()).map(l => l.replace(/^ {10}/, '')).join('\n')
  const ws = mkdtempSync(path.join(tmpdir(), 'prod-manifest-'))
  const sha = 'b'.repeat(40)
  mkdirSync(path.join(ws, 'web')); writeFileSync(path.join(ws, 'web/package-lock.json'), '{"lockfileVersion":3}\n')
  mkdirSync(path.join(ws, '.prod-tools/ops/prod'), { recursive: true })
  writeFileSync(path.join(ws, '.prod-tools/ops/prod/prebuilt-manifest.mjs'), readFileSync(fileURLToPath(new URL('../../ops/prod/prebuilt-manifest.mjs', import.meta.url))))
  const src = path.join(ws, 'src'); mkdirSync(path.join(src, '.next'), { recursive: true }); mkdirSync(path.join(src, 'node_modules'))
  writeFileSync(path.join(src, '.build-commit'), sha + '\n'); writeFileSync(path.join(src, '.next/BUILD_ID'), 'id\n'); writeFileSync(path.join(src, 'node_modules/x'), 'x')
  mkdirSync(path.join(ws, 'prebuilt'))
  assert.equal(spawnSync('tar', ['-czf', path.join(ws, `prebuilt/prod-next-${sha}.tgz`), '.next', '.build-commit'], { cwd: src }).status, 0)
  assert.equal(spawnSync('tar', ['-czf', path.join(ws, `prebuilt/prod-modules-${sha}.tgz`), 'node_modules'], { cwd: src }).status, 0)
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', run], { cwd: ws, env: { ...process.env, SHA: sha }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const m = JSON.parse(readFileSync(path.join(ws, `prebuilt/prod-prebuilt-${sha}.json`), 'utf8'))
  assert.equal(m.commit, sha); assert.ok(m.next.unpacked_bytes > 0 && m.modules.unpacked_bytes > 0)
})
