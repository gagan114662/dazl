import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// #942: with cacheComponents on, a server component that reads the session during render reaches auth-db's nowS()
// (Date.now) for the expiry check. Unless the render is bound to the request first, Next logs "encountered the
// unstable value Date.now() while prerendering" on /app, /app/leads and /settings. The fix is request binding,
// never caching: every server component that calls a session read must `await connection()` (next/server)
// before it. This walks app/ so a new authenticated page that forgets the binding fails here.

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'app')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? (n === 'api' ? [] : walk(p)) : p.endsWith('.tsx') ? [p] : []
  })

// a call, not the import line
const SESSION_CALL = /\b(?:await\s+)?(requireUser|getSessionUser|hasLiveSession)\s*\(/g

function offenders(): string[] {
  const out: string[] = []
  for (const file of walk(APP)) {
    const src = readFileSync(file, 'utf8')
    if (/^\s*['"]use client['"]/.test(src)) continue
    const calls = [...src.matchAll(SESSION_CALL)].filter(m => !/import\s*\{[^}]*$/.test(src.slice(Math.max(0, m.index! - 200), m.index)))
    if (!calls.length) continue
    const rel = relative(APP, file)
    if (!/import\s*\{[^}]*\bconnection\b[^}]*\}\s*from\s*['"]next\/server['"]/.test(src)) { out.push(`${rel}: no connection import from next/server`); continue }
    const bind = src.indexOf('await connection()')
    for (const c of calls) if (bind < 0 || bind > c.index!) out.push(`${rel}: ${c[1]}() before await connection()`)
  }
  return out
}

test('#942: authenticated server components bind to the request before reading the session', () => {
  assert.deepEqual(offenders(), [])
})

test('#942: the gate covers the known authenticated renders', () => {
  for (const f of ['app/layout.tsx', 'app/settings/page.tsx', 'app/preview/[id]/page.tsx']) {
    const src = readFileSync(join(APP, f), 'utf8')
    assert.ok(src.includes('await connection()'), `${f} binds to the request`)
  }
})

test('#942: the session read itself stays uncached and request-time', () => {
  const authDb = readFileSync(join(APP, '..', 'lib', 'auth-db.ts'), 'utf8')
  assert.ok(!/['"]use cache/.test(authDb), 'auth-db must not use "use cache"')
  assert.match(authDb, /const nowS = \(\) => Math\.floor\(Date\.now\(\) \/ 1000\)/)
})
