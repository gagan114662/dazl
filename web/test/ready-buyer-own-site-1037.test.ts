// #1037: runs test/helpers/ready-buyer-1037-runtime.mts in a child process (the real site crawl, the real /api/leads and /api/home/ready
// handlers with their own session and store). A lead is READY only when the company's own page names its buyer with a title and LinkedIn.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('#1037 a ready lead names its buyer from the company\'s own site with title and LinkedIn; every other lead is held (real crawl, real handlers; child process)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0' } as NodeJS.ProcessEnv; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/ready-buyer-1037-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 180000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2\b/); assert.match(r.stdout, /# fail 0/)
})
