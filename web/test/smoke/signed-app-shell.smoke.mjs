// Run after building Next: node --experimental-strip-types test/smoke/signed-app-shell.smoke.mjs
// Test actual signed streaming, not just unsigned /api/health or a static shell.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { pickUiPort } from '../helpers/ui-port.mjs'

const web = fileURLToPath(new URL('../..', import.meta.url))
assert.ok(existsSync(path.join(web, '.next/BUILD_ID')), 'Build the production app before running the signed shell smoke')
const dir = mkdtempSync(path.join(tmpdir(), 'dazl-app-shell-'))
const dbPath = path.join(dir, 'app.db')
const token = randomBytes(32).toString('hex')
const statusText = 'Opening your workspace…'
const routes = [
  ['/app', '<h1 class="text-3xl font-bold tracking-tight">Welcome to dazl</h1>'],
  ['/app/business', '>Loading what dazl knows about your business...</p>'],
  ['/app/plays', '>Loading your plays...</p>'],
]

async function verify(base, route, pageMarker, mode) {
  const start = performance.now()
  const elapsed = () => Math.round(performance.now() - start)
  const signed = mode !== 'invalid-cookie'
  const r = await fetch(base + route, {
    headers: { cookie: 'dazl_session=' + (signed ? token : 'a'.repeat(64)) },
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
  const headersMs = elapsed()
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let html = '', firstMs = null, contentMs = null
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    firstMs ??= elapsed()
    html += decoder.decode(chunk.value, { stream: true })
    if (html.includes(pageMarker)) contentMs ??= elapsed()
  }
  const status = /<div[^>]*\brole="status"[^>]*>\s*<p[^>]*>Opening your workspace…<\/p>/.exec(html)
  console.log(JSON.stringify({ route, mode, status: r.status, headersMs, firstMs, contentMs, totalMs: elapsed(), shellStatus: !!status }))
  if (signed) {
    assert.equal(r.status, 200)
    assert.ok(status, route + ': initial shell must have an accessible loading status')
    assert.notEqual(contentMs, null, route + ': signed page body must finish streaming')
    assert.ok(html.indexOf(statusText) < html.indexOf(pageMarker), route + ': loading status must precede page content')
  } else {
    assert.equal(r.status, 307)
    const location = r.headers.get('location')
    assert.ok(location, route + ': invalid session must redirect to sign-in')
    assert.equal(new URL(location, base + route).href, base + '/sign-in')
    assert.equal(contentMs, null)
    assert.equal(status, null)
  }
}

async function testRoute(route, pageMarker) {
  const port = pickUiPort()
  const base = 'http://127.0.0.1:' + port
  const srv = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: web,
    env: {
      PATH: process.env.PATH, DB_PATH: dbPath, SCAN_MAX_CONCURRENT: '0',
      SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NEXT_TELEMETRY_DISABLED: '1',
      NODE_OPTIONS: '--experimental-strip-types --import ' + path.join(web, 'test/helpers/net-fence.ts'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  try {
    let ready = false
    for (let i = 0; i < 80 && !ready && srv.exitCode === null; i++) {
      try {
        const response = await fetch(base + '/sign-in', { signal: AbortSignal.timeout(1000) })
        await response.arrayBuffer()
        ready = response.ok
      } catch (err) {
        if (!(err instanceof TypeError) && err?.name !== 'TimeoutError') throw err
        await new Promise(r => setTimeout(r, 100))
      }
    }
    assert.ok(ready, 'Next server did not start')
    for (const mode of ['cold-signed', 'warm-signed', 'invalid-cookie']) await verify(base, route, pageMarker, mode)
  } finally {
    const exited = srv.exitCode === null ? new Promise(resolve => srv.once('exit', resolve)) : Promise.resolve()
    srv.kill('SIGTERM')
    await exited
  }
}

try {
  const db = new Database(dbPath)
  try {
    migrateAllSqlite(db)
    const hashed = createHash('sha256').update(token).digest('hex')
    db.prepare("INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES ('fixture','example@local.test','x','y',1)").run()
    db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,'fixture',?)").run(hashed, Math.floor(Date.now() / 1000) + 3600)
  } finally {
    db.close()
  }
  for (const [route, marker] of routes) await testRoute(route, marker)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
