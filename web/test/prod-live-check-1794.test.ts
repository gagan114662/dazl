import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/prod-live-check.mjs', import.meta.url))
const netFence = new URL('./helpers/net-fence.ts', import.meta.url).href
const sha = 'a'.repeat(40)
const redirects = new Map([
  ['/signup', '/sign-up'], ['/register', '/sign-up'],
  ['/signin', '/sign-in'], ['/login', '/sign-in'], ['/app', '/sign-in?next=%2Fapp'],
])
const pages = ['/', '/pricing', '/privacy', '/terms', '/sign-in', '/sign-up']

async function fixture(broken: boolean) {
  const seen: string[] = []
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    seen.push(path)
    if (path === '/api/health') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ commit: broken ? 'b'.repeat(40) : sha }))
      return
    }
    if (redirects.has(path) && !(broken && path === '/signup')) {
      res.writeHead(path === '/app' ? 307 : 308, {
        Location: broken && path === '/login' ? '/sign-up' : redirects.get(path)!,
      })
      res.end()
      return
    }
    res.writeHead(broken && path === '/pricing' ? 503 : 200, { 'Content-Type': 'text/html' })
    res.end(path === '/'
      ? `<h1 class="lp-h1">${broken ? 'Welcome' : 'Say who you want to reach.'}</h1>`
      : `<p>${broken && path === '/privacy' ? 'DRAFT' : 'Published page'}</p>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return { ...(await run(process.execPath, ['--experimental-strip-types', '--import', netFence, script, `http://127.0.0.1:${address.port}`, sha])), seen }
  } catch (error) {
    throw Object.assign(error as Error, { seen })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('#1794 checks the served commit, public HTML and all redirects without following them', async () => {
  const { stdout, seen } = await fixture(false)
  assert.deepEqual(seen.sort(), ['/api/health', ...pages, ...redirects.keys()].sort())
  const lines = stdout.trim().split('\n')
  assert.ok(lines.length >= seen.length)
  assert.ok(lines.every(line => line.startsWith('PASS ')), stdout)
})

test('#1794 reports independent defects and exits nonzero', async () => {
  await assert.rejects(fixture(true), (error: unknown) => {
    const result = error as { code: number; stdout: string; seen: string[] }
    assert.equal(result.code, 1)
    assert.deepEqual(result.seen.sort(), ['/api/health', ...pages, ...redirects.keys()].sort())
    assert.match(result.stdout, /^FAIL .*\/api\/health/m)
    assert.match(result.stdout, /^FAIL .*h1/m)
    assert.match(result.stdout, /^FAIL .*\/pricing.*503/m)
    assert.match(result.stdout, /^FAIL .*\/privacy.*DRAFT/m)
    assert.match(result.stdout, /^FAIL .*\/signup/m)
    assert.match(result.stdout, /^FAIL .*\/login/m)
    assert.match(result.stdout, /^PASS .*\/app/m)
    return true
  })
})
