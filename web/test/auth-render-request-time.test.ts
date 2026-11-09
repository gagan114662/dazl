import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// #942: with cacheComponents on, a server component that reads the session during render reaches auth-db's nowS()
// (Date.now) for the expiry check. Unless the render is bound to the request first, Next logs "encountered the
// unstable value Date.now() while prerendering" on /app, /app/leads and /settings. The fix is request binding,
// never caching: every server component function that calls a session read must `await connection()` (next/server)
// BEFORE that call, inside the same function (or one that encloses it). This walks app/ so a new authenticated page
// that forgets the binding fails here. The check is per function and ignores comments: a binding in another
// function, or one that only appears in a comment, does not count.

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'app')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? (n === 'api' ? [] : walk(p)) : p.endsWith('.tsx') ? [p] : []
  })

// a call, not the import line
const SESSION_CALL = /\b(?:await\s+)?(requireUser|getSessionUser|hasLiveSession)\s*\(/g
const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with'])

// comments become spaces (same length, so indices still line up)
export const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, lead: string | undefined) => (lead ?? '') + ' '.repeat(m.length - (lead?.length ?? 0)))

// the body ranges [open, close] of every function-like block: `function f(...) {`, `async (...) => {`, `x => {`, methods `f(...) {`
function functionBodies(src: string): [number, number][] {
  const stack: { open: number; fn: boolean }[] = []; const out: [number, number][] = []
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      const before = src.slice(0, i).replace(/\s+$/, '')
      let fn = /=>$/.test(before)
      if (!fn) {
        const m = /(?::\s*[\w<>\[\]|,.\s]+?)?$/.exec(before)
        const head = m ? before.slice(0, m.index).replace(/\s+$/, '') : before
        if (head.endsWith(')')) {
          let depth = 0, j = head.length - 1
          for (; j >= 0; j--) { if (head[j] === ')') depth++; else if (head[j] === '(') { depth--; if (!depth) break } }
          const name = /([A-Za-z_$][\w$]*)\s*$/.exec(head.slice(0, j))?.[1]
          fn = j >= 0 && !(name && NOT_FUNCTIONS.has(name))
        }
      }
      stack.push({ open: i, fn })
    } else if (ch === '}') { const top = stack.pop(); if (top?.fn) out.push([top.open, i]) }
  }
  return out
}

// each session call that has no `await connection()` earlier in its own function or an enclosing one
export function unboundCalls(source: string): string[] {
  const src = stripComments(source)
  if (/^\s*['"]use client['"]/.test(src)) return []
  const calls = [...src.matchAll(SESSION_CALL)].filter(m => !/import\s*\{[^}]*$/.test(src.slice(Math.max(0, m.index! - 200), m.index)))
  if (!calls.length) return []
  const bodies = functionBodies(src)
  if (!/import\s*\{[^}]*\bconnection\b[^}]*\}\s*from\s*['"]next\/server['"]/.test(src)) return calls.map(c => `${c[1]}(): no connection import from next/server`)
  return calls.filter(c => {
    const at = c.index!
    const chain = bodies.filter(([o, e]) => o < at && at < e)
    return !chain.some(([o]) => { const b = src.slice(o, at).search(/await\s+connection\s*\(\s*\)/); return b >= 0 })
  }).map(c => `${c[1]}() before await connection()`)
}

function offenders(): string[] {
  const out: string[] = []
  for (const file of walk(APP)) for (const o of unboundCalls(readFileSync(file, 'utf8'))) out.push(`${relative(APP, file)}: ${o}`)
  return out
}

test('#942: authenticated server components bind to the request before reading the session', () => {
  assert.deepEqual(offenders(), [])
})

test('#942: the per-function check catches what a whole-file search missed (fixtures)', () => {
  const head = "import { connection } from 'next/server'\nimport { requireUser } from '@/lib/auth'\n"
  // a bound A() and an unbound B(): one binding in the file must not hide B
  assert.deepEqual(unboundCalls(head + 'async function A() { await connection(); await requireUser() }\nasync function B() { await requireUser() }\n'), ['requireUser() before await connection()'])
  // a comment that mentions the binding is not a binding
  assert.deepEqual(unboundCalls(head + '// we used to await connection() here\nasync function B() { await requireUser() }\n'), ['requireUser() before await connection()'])
  assert.deepEqual(unboundCalls(head + '/* await connection() */ export default async function P() { await requireUser() }\n'), ['requireUser() before await connection()'])
  // binding AFTER the read is too late
  assert.deepEqual(unboundCalls(head + 'async function C() { await requireUser(); await connection() }\n'), ['requireUser() before await connection()'])
  // no import at all
  assert.deepEqual(unboundCalls("import { requireUser } from '@/lib/auth'\nasync function D() { await requireUser() }\n"), ['requireUser(): no connection import from next/server'])
  // the legitimate shapes pass: bound first, arrow functions, a read inside an if block of a bound function, client files
  assert.deepEqual(unboundCalls(head + 'async function A() { await connection(); await requireUser() }\nasync function A2() { await connection(); if (x) { await requireUser() } }\n'), [])
  assert.deepEqual(unboundCalls(head + 'export const Page = async () => { await connection(); const u = await requireUser(); return u }\n'), [])
  assert.deepEqual(unboundCalls("'use client'\nimport { requireUser } from '@/lib/auth'\nfunction E() { requireUser() }\n"), [])
})

test('#942: the gate covers the known authenticated renders', () => {
  for (const f of ['app/layout.tsx', 'app/settings/page.tsx', 'app/preview/[id]/page.tsx']) {
    const src = stripComments(readFileSync(join(APP, f), 'utf8'))
    assert.ok(/await\s+connection\s*\(\s*\)/.test(src), `${f} binds to the request`)
    assert.deepEqual(unboundCalls(readFileSync(join(APP, f), 'utf8')), [], `${f}: every session read is bound`)
  }
})

test('#942: the session read itself stays uncached and request-time', () => {
  const authDb = readFileSync(join(APP, '..', 'lib', 'auth-db.ts'), 'utf8')
  assert.ok(!/['"]use cache/.test(authDb), 'auth-db must not use "use cache"')
  assert.match(authDb, /const nowS = \(\) => Math\.floor\(Date\.now\(\) \/ 1000\)/)
})
