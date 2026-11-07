// #988 operator package (ops/staging/fixture-988/): the shipped copies are byte-identical to the reviewed sources, SHA256SUMS matches them, and the host script is bound to the installed layout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const pkg = (p: string) => readFileSync(`${root}ops/staging/fixture-988/${p}`)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const PAIRS: [string, string][] = [['scripts/staging-fixture-988.mts', 'web/scripts/staging-fixture-988.mts'], ['scripts/staging-fixture-988-checks.mts', 'web/scripts/staging-fixture-988-checks.mts'], ['lib/staging.ts', 'web/lib/staging.ts']]

test('#988 package: every shipped file is byte-identical to its reviewed source (no drift), and SHA256SUMS lists exactly them', () => {
  for (const [a, b] of PAIRS) assert.equal(sha(pkg(a)), sha(readFileSync(root + b)), `${a} == ${b}`)
  const sums = new Map(pkg('SHA256SUMS').toString().trim().split('\n').map(l => { const [h, f] = l.split(/\s+/); return [f, h] as const }))
  assert.deepEqual([...sums.keys()].sort(), PAIRS.map(p => p[0]).sort())
  for (const [f, h] of sums) assert.equal(sha(pkg(f)), h, `${f} matches SHA256SUMS`)
  assert.ok(!existsSync(`${root}ops/staging/fixture-988.sh`), 'the superseded wrapper (wrong lock, assumed git checkout) is gone')
})
test('#988 package: lib/staging.ts is self-contained (the package ships no web/ tree, so it must import nothing)', () => {
  assert.doesNotMatch(pkg('lib/staging.ts').toString(), /^import /m)
  for (const f of ['scripts/staging-fixture-988.mts', 'scripts/staging-fixture-988-checks.mts']) for (const m of pkg(f).toString().matchAll(/from '(\.[^']+)'/g)) assert.match(m[1], /^\.\/staging-fixture-988\.mts$|^\.\.\/lib\/staging\.ts$/, `${f} imports only package files`)
})
test('#988 package: the host script is bound to the installed layout, asserts the real service, and never writes into the release', () => {
  const s = pkg('fixture-988.sh').toString()
  assert.equal(spawnSync('bash', ['-n', `${root}ops/staging/fixture-988/fixture-988.sh`]).status, 0, 'bash -n')
  for (const needle of ['LOCK=/srv/dazl-staging/.deploy.lock', 'CURRENT=/srv/dazl-staging/current', 'EXPECT_BUILD=3fb1e7dfdcca1bdca65af3113b5aca3fa55551cf', 'EXPECT_INSTANCE=786b801b2fa7', 'STAGING_DB=/var/lib/dazl-staging/app.db', 'SERVICE=dazl-staging.service', 'sha256sum --check', '--preserve-symlinks --preserve-symlinks-main', '/proc/$PID/environ', 'install -d -m 0700 -o "$RUN_AS" -g "$RUN_AS" "$OUT_ROOT"', 'flock -n 9'])
    assert.ok(s.includes(needle), needle)
  assert.doesNotMatch(s, /var\/lib\/dazl-staging-deploy\/\.deploy\.lock/, 'not the wrong lock'); assert.doesNotMatch(s, /\$ROOT\/web|git -C/, 'no source-checkout assumption')
  const code = s.replace(/^\s*#.*$/gm, '').replace(/ #[^\n"']*$/gm, '').replace(/"(\\.|[^"\\])*"/g, '""')   // comments and message strings removed: what is left is what executes
  assert.doesNotMatch(code, /\bkill|pkill|killall|-9\b|rm -rf|systemctl kill/, 'no hard kill, no broad cleanup')
  assert.doesNotMatch(s, /(>|>>|tee|cp|mv|rm|ln -s\S* \S+) +"?\$REL\b|\$CURRENT"? *(>|=\$)/, 'nothing is written into the release or current')
  // preflight is read-only: everything that stops, locks or creates durable state sits after the preflight exit
  const afterPre = s.slice(s.indexOf('if [ "$MODE" = preflight ]; then\n  note "WOULD DO'))
  const beforePre = s.slice(0, s.indexOf('if [ "$MODE" = preflight ]; then\n  note "WOULD DO'))
  for (const w of ['systemctl stop', 'systemctl start', 'flock -n 9', 'exec 9>>']) { assert.ok(!beforePre.includes(w) || /note "WOULD DO|^#/m.test(w), w); }
  assert.ok(!/systemctl (stop|start|restart)/.test(beforePre.replace(/#.*$/gm, '').replace(/note "[^"]*"/g, '')), 'no stop/start before the preflight exit')
  assert.ok(afterPre.includes('trap finish EXIT') && (code.match(/systemctl start/g) ?? []).length === 1, 'exactly one start, in the exit handler')
  assert.ok(!/(until|while) .*systemctl start/.test(s), 'no retry loop around start')
})
test('#988 package: running the script without root, or from a mode it does not know, refuses before touching anything', () => {
  const run = (...a: string[]) => spawnSync('bash', [`${root}ops/staging/fixture-988/fixture-988.sh`, ...a], { encoding: 'utf8' })
  assert.equal(run().status, 2); assert.equal(run('nonsense').status, 2)
  if (process.getuid && process.getuid() !== 0) { const r = run('preflight'); assert.equal(r.status, 3); assert.match(r.stderr, /run as root/) }
})
