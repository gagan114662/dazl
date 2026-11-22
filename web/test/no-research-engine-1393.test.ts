// #1393 (launch brief step 2): one lead engine. The second, switched-off engine (lib/research, LEAD_ENGINE=research) is gone, and nothing
// in the app, scripts or tests can bring it back by import or by the switch. Red on main before this PR: lib/research exists and runner.ts imports it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WEB = new URL('..', import.meta.url).pathname
const files = (dir: string): string[] => readdirSync(join(WEB, dir)).flatMap(n => {
  const rel = join(dir, n)
  if (n === 'node_modules' || n.startsWith('.')) return []
  return statSync(join(WEB, rel)).isDirectory() ? files(rel) : /\.(?:ts|tsx|mts|mjs|js)$/.test(n) ? [rel] : []
})

test('#1393 the research engine is deleted: no lib/research, no import of it, no LEAD_ENGINE switch', () => {
  assert.equal(existsSync(join(WEB, 'lib/research')), false, 'lib/research is gone')
  const self = 'test/no-research-engine-1393.test.ts'
  for (const f of ['lib', 'app', 'scripts', 'test'].flatMap(files)) {
    if (f === self) continue
    const src = readFileSync(join(WEB, f), 'utf8')
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/research\/|import\(\s*['"][^'"]*\/research\//, `${f} imports the deleted research engine`)
    assert.doesNotMatch(src, /process\.env\.LEAD_ENGINE|researchEngineOn/, `${f} reads the deleted engine switch`)
  }
})
