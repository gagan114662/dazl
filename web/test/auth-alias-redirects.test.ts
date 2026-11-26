import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #1929: /login, /signin, /signup, /register must answer with a real 308 redirect, not an error page.
// Each page calls permanentRedirect, but with cacheComponents on and no dynamic API call the route is
// prerendered at build time: the redirect throw is captured and Next serves `<html id="__next_error__">`
// with HTTP 200 (observed on prod AND staging; raw-HTML clients, crawlers and link unfurlers get the
// error shell). The sign-up page documents the fix (review of #670): `await connection()` binds the
// route to the request so the redirect throws per-request. This fails until the four pages do that.

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'app')

// comments become spaces (same length, so indices still line up)
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, lead: string | undefined) => (lead ?? '') + ' '.repeat(m.length - (lead?.length ?? 0)))

const LEGACY: [string, string][] = [
  ['login', '/sign-in'],
  ['signin', '/sign-in'],
  ['signup', '/sign-up'],
  ['register', '/sign-up'],
]

const NO_CONNECTION = 'permanentRedirect without await connection(): cacheComponents prerenders the throw into the __next_error__ shell'

export function aliasProblems(source: string): string[] {
  const src = stripComments(source)
  const problems: string[] = []
  if (!/import\s*\{[^}]*\bconnection\b[^}]*\}\s*from\s*['"]next\/server['"]/.test(src)) problems.push('no connection import from next/server')
  const conn = src.search(/await\s+connection\s*\(\s*\)/)
  const redir = src.search(/\bpermanentRedirect\s*\(/)
  if (redir < 0) problems.push('no permanentRedirect call')
  else if (conn < 0) problems.push(NO_CONNECTION)
  else if (conn > redir) problems.push('await connection() must come before permanentRedirect')
  return problems
}

test('#1929: legacy auth alias pages redirect at request time, not as a prerendered error shell', () => {
  const out: string[] = []
  for (const [route, dest] of LEGACY) {
    const src = readFileSync(join(APP, route, 'page.tsx'), 'utf8')
    for (const p of aliasProblems(src)) out.push(`${route}/page.tsx: ${p}`)
    assert.ok(stripComments(src).includes(`permanentRedirect(withQuery('${dest}'`), `${route}/page.tsx redirects to ${dest} with the query preserved`)
  }
  assert.deepEqual(out, [])
})

test('#1929 fixtures: a comment is not a binding, and a late binding does not count', () => {
  const good = "import { connection } from 'next/server'\nimport { permanentRedirect } from 'next/navigation'\nexport default async function P() { await connection(); permanentRedirect('/sign-in') }\n"
  assert.deepEqual(aliasProblems(good), [])
  const commented = "import { permanentRedirect } from 'next/navigation'\n// await connection()\nexport default async function P() { permanentRedirect('/sign-in') }\n"
  assert.deepEqual(aliasProblems(commented), ['no connection import from next/server', NO_CONNECTION])
  const late = "import { connection } from 'next/server'\nimport { permanentRedirect } from 'next/navigation'\nexport default async function P() { permanentRedirect('/sign-in'); await connection() }\n"
  assert.deepEqual(aliasProblems(late), ['await connection() must come before permanentRedirect'])
})
