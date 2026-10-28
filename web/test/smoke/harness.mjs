// Shared setup for production-build smoke checks (test/smoke/*.smoke.mjs).
// - Throwaway SQLite database with one seeded user and session; removed on stop.
// - The server runs under test/helpers/net-fence.ts: secrets are scrubbed from its env and any non-loopback
//   connection from the server process throws, so no page load can reach a provider, a paid API or a website.
// - Browser requests to any other origin are aborted.
// - Missing playwright/chromium or a missing build is NOT RUN (exit 2), never success. SMOKE_ALLOW_SKIP=1 turns
//   that into exit 0 for machines that cannot run a browser, and says so.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'package.json'))

// Every page under app/app, so a new page is covered without editing a smoke check. Dynamic segments are skipped.
export function appRoutes(dir = path.join(root, 'app/app'), route = '/app') {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { if (!name.startsWith('[') && !name.startsWith('_')) out.push(...appRoutes(full, `${route}/${name}`)) }
    else if (name === 'page.tsx') out.push(route)
  }
  return out.sort()
}

export function notRun(reason) {
  if (process.env.SMOKE_ALLOW_SKIP === '1') { console.log(`NOT RUN (allowed by SMOKE_ALLOW_SKIP=1): ${reason}`); process.exit(0) }
  console.log(`NOT RUN: ${reason}`); process.exit(2)
}

export function loadPlaywright() {
  try { return require('playwright') } catch (e) { return notRun(e.message.split('\n')[0]) }
}

// opts.env: extra server environment; opts.prepare(dbPath): runs on the throwaway database before the server starts.
export async function startServer(opts = {}) {
  if (!existsSync(path.join(root, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
  const Database = require('better-sqlite3')
  const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-smoke-'))
  const DB_PATH = path.join(tmp, 'app.db')
  const db = new Database(DB_PATH)
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, business_name TEXT, sells TEXT, website TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()));
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);`)
  db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES ('smoke-user', 'smoke@example.test', 'x', 'y')").run()
  const token = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'smoke-user', Math.floor(Date.now() / 1000) + 3600)
  db.close()
  if (opts.prepare) await opts.prepare(DB_PATH)
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const base = `http://127.0.0.1:${port}`
  const fence = path.join(root, 'test/helpers/net-fence.ts')
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', DB_PATH, SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', PUBLIC_BASE_URL: base, NODE_OPTIONS: `--experimental-strip-types --import ${fence}`, ...opts.env }
  const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; server.stdout.on('data', d => { log += d }); server.stderr.on('data', d => { log += d })
  const stop = () => { server.kill('SIGTERM'); rmSync(tmp, { recursive: true, force: true }) }
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/sign-in`); break } catch { if (i > 150 || server.exitCode !== null) { stop(); throw new Error(`server did not start\n${log}`) } await new Promise(r => setTimeout(r, 200)) }
  }
  return { base, token, stop, log: () => log }
}

export async function newContext(browser, { base, token }) {
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name: 'dazl_session', value: token, url: base }])
  await ctx.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  return ctx
}
