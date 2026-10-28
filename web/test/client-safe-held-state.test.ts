// held-state.ts is reached from the browser bundle (outreach follow-up client); its import graph must stay free of server-only modules.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SERVER_ONLY = /better-sqlite3|node:|connectors\/store|sitecrawl|sales-hiring-gate|\bfs\b/
function graph(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const m of readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\b)[^'"\n]*?from\s+'(\.[^']+)'/gm)) graph(resolve(dirname(file), m[1]), seen)
  return seen
}
test('held-state value imports never reach server-only modules', () => {
  const files = [...graph(resolve(import.meta.dirname, '../lib/scan/held-state.ts'))]
  assert.ok(files.length >= 2)
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/^import\s+(?!type\b)[^'"\n]*?from\s+'([^']+)'/gm)) assert.ok(!SERVER_ONLY.test(m[1]), `${f} imports ${m[1]}`)
  }
})
