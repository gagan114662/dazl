// docs/NEVER-AGAIN.md stays true: every entry has its fields, every file it cites exists, the gates it names are still
// wired, and every session is told to read it first. Run: node --test '.github/scripts/*.test.mjs' (never-again-gates.yml).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const read = p => readFileSync(path.join(repo, p), 'utf8')
const doc = read('docs/NEVER-AGAIN.md')
const entries = doc.split(/^## /m).slice(1)

test('every NEVER-AGAIN entry states mistake, date, rule and how it is enforced', () => {
  assert.ok(entries.length >= 11, `found ${entries.length} entries`)
  for (const e of entries) {
    const title = e.split('\n')[0]
    for (const f of ['**Mistake:**', '**Date:**', '**Rule:**', '**Enforced by ('])
      assert.ok(e.includes(f), `"${title}" is missing ${f}`)
    assert.match(e, /\*\*Date:\*\*[^\n]*20\d\d-\d\d/, `"${title}": date needs a year-month`)
    assert.match(e, /\*\*Enforced by \((automated|partly automated|note-only|automated, not required)\):\*\*/, `"${title}": say automated or note-only`)
  }
})

test('every file NEVER-AGAIN.md cites exists', () => {
  const cited = [...doc.matchAll(/`((?:\.github|ops|web|docs)\/[^`*\s]+?)`/g)].map(m => m[1])
  assert.ok(cited.length > 10)
  for (const p of cited) assert.ok(existsSync(path.join(repo, p)), `cited but missing: ${p}`)
})

test('the gates NEVER-AGAIN.md names are still wired', () => {
  const acc = read('.github/workflows/acceptance-gate.yml')
  assert.match(acc, /^  no-closing-keywords:\n    if: github\.event_name == 'pull_request'/m, '#6: no-closing-keywords job')
  assert.match(acc, /^on:\n  pull_request:/m)
  assert.match(read('web/test/tenant-isolation-manifest.test.ts'), /test\('the manifest lists exactly the route handlers that exist'/, '#7')
  assert.match(read('web/test/request-log.test.ts'), /test\('the route list matches the route files under app\//, '#7')
  assert.match(JSON.parse(read('web/package.json')).scripts.test, /test\/\*\.test\.ts/, '#7: npm test runs test/*.test.ts')
  assert.match(read('.github/workflows/web-ci.yml'), /run: npm test/, '#7: web-ci runs npm test')
  assert.match(read('ops/prod/test_prod_prebuilt.py'), /def test_the_deploy_script_contains_no_build_step/, '#1 prod')
  assert.match(read('ops/staging/deploy.sh'), /REFUSED: no on-box build/, '#1 staging')
  assert.match(read('.github/workflows/release-preflight.yml'), /unittest discover -s ops -p 'test_\*\.py'/, '#1: ops/test_never_again.py runs')
  assert.ok(existsSync(path.join(repo, '.github/workflows/live-check-gate.yml')), '#3')
})

test('every session is told to read docs/NEVER-AGAIN.md first', () => {
  for (const f of ['CLAUDE.md', 'web/AGENTS.md']) {
    const head = read(f).split('\n').slice(0, 6).join('\n')
    assert.match(head, /Read `docs\/NEVER-AGAIN\.md` first, every session/, `${f}: the NEVER-AGAIN line must be at the top`)
  }
})

// Hermes review 7: the all-PR gate itself. Removing any of its three steps, or giving it a path filter (so it would skip
// workflow-only or docs-only pull requests), fails here.
test('never-again-gates.yml runs all three checks on every pull request, with no path filter', () => {
  const wf = read('.github/workflows/never-again-gates.yml')
  const run = cmd => wf.split('\n').some(l => l.trim() === `run: ${cmd}`)
  assert.ok(run("node --test '.github/scripts/*.test.mjs'"), 'the doc + live-check gate tests')
  assert.ok(run("python3 -m unittest discover -s ops -p 'test_never_again.py' -v"), 'ops/test_never_again.py')
  assert.ok(run('shellcheck -S error ops/staging/deploy.sh ops/staging/pull-prebuilt.sh ops/prod/deploy-prod.sh ops/prod/pull-release.sh'), 'shellcheck on the 4 deploy scripts')
  assert.match(wf, /^on:\n  pull_request:\n  push:\n    branches: \[main\]\n/m, 'every pull request, and main')
  assert.doesNotMatch(wf, /^\s*(paths|paths-ignore|branches-ignore):/m, 'no path filter')
  assert.doesNotMatch(wf, /^\s*if:|continue-on-error/m, 'no step or job is conditional or allowed to fail')
})

test('no test in the gate suites is skipped or left as a todo', () => {
  for (const f of ['.github/scripts/never-again.test.mjs', '.github/scripts/live-check-gate.test.mjs'].map(read))
    assert.doesNotMatch(f, /\{\s*(todo|skip)\s*:|test\.(todo|skip|only)\(/)
  assert.doesNotMatch(read('ops/test_never_again.py'), /unittest\.skip|skipTest|expectedFailure/)
})

// Hermes review 2: the staging runbook must not walk an operator into the refused on-box build (the old reset recipe stopped
// staging, deleted its database and then started the refused service).
test('docs/STAGING.md never starts or enables the on-box-build units, and its reset recipe reseeds without a deploy', () => {
  const md = read('docs/STAGING.md')
  const cmds = md.split('\n').filter(l => /^\s*(systemctl|install)\b/.test(l.replace(/^\s*(\d+\.|[-*])\s*/, '')) || /`systemctl[^`]*`/.test(l))
  for (const l of cmds) {
    assert.doesNotMatch(l, /systemctl\s+(start|restart|enable(\s+--now)?)\s+[^`#\n]*dazl-staging-deploy\.(service|timer)/, `starts the refused on-box build: ${l.trim()}`)
    assert.doesNotMatch(l, /^\s*install\b.*dazl-staging-deploy\.(service|timer)/, `installs the on-box-build units: ${l.trim()}`)
  }
  assert.doesNotMatch(md, /each deploy runs a build|on a box that builds itself/)
  const reset = md.slice(md.indexOf('**Reset the data.**'), md.indexOf('**Load on the box:**'))
  assert.ok(reset.length > 200, 'the reset section exists')
  assert.match(reset, /npm run -s db:migrate && node --experimental-strip-types --no-warnings scripts\/staging-seed\.mts/, 'reseeds with the migrate + seed command')
  // the same command deploy.sh runs (its STAGING_MIGRATE default), so the recipe cannot drift from a deploy's seed
  assert.ok(read('ops/staging/deploy.sh').includes("MIGRATE=${STAGING_MIGRATE:-'npm run -s db:migrate && node --experimental-strip-types --no-warnings scripts/staging-seed.mts'}"))
  assert.match(reset, /scripts\/staging-seed\.mts' \) \\\n\s+&& systemctl start dazl-staging &&/, 'starts the service only when the seed worked')
  assert.match(reset, /systemctl is-active dazl-staging-prebuilt\.service/, 'checks no deploy is running')
  // what the recipe says about current-sha is what deploy.sh does: with no current-sha it takes the live release's name
  assert.match(read('ops/staging/deploy.sh'), /if \[ -z "\$cur" \]; then l=\$\(live_release\); \[ -n "\$l" \] && \[ -e "\$l\/\.complete" \] && cur=\$\(basename "\$l"\); fi\n\[ "\$new" != "\$cur" \] \|\| exit 0/)
  for (const f of ['ops/staging/pull-prebuilt.sh', 'ops/staging/dazl-staging-prebuilt.service', 'ops/staging/dazl-staging-prebuilt.timer']) assert.ok(existsSync(path.join(repo, f)), f)
})
