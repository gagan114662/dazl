import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { JOBS, TICK_INFRA } from './job-isolation-manifest.ts'

// Every background worker must map to a meaningful two-tenant test, and every global maintenance job to a bounded,
// gated-behavior test with a stated reason. A new worker or queue kind that ships unclassified fails here.

const tickSrc = readFileSync(new URL('../app/api/internal/tick/route.ts', import.meta.url), 'utf8')
const TWO_TENANT_NAME = /two tenants|another tenant|tenant isolation|other tenant|cross.tenant|B cannot|cannot see A|only A's|only their own/i

// Named value imports from '@/lib/...' in the tick route (type-only imports excluded).
function tickLibImports(): string[] {
  const names: string[] = []
  for (const m of tickSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@\/lib\/[^']+'/g))
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '')
      if (name && !part.trim().startsWith('type ')) names.push(name.split(' as ').pop()!.trim())
    }
  return names
}

test('every lib worker the tick route calls is classified as a job or documented infra', () => {
  const workers = new Set(JOBS.map(j => j.worker))
  const unclassified = tickLibImports().filter(n => new RegExp(`\\b${n}\\s*\\(`).test(tickSrc) && !workers.has(n) && !TICK_INFRA.has(n))
  assert.deepEqual(unclassified, [], `tick route calls unclassified lib functions: ${unclassified.join(', ')}`)
})

test('every queue kind enqueued outside queue internals has a manifest entry', () => {
  const kinds = new Set(JOBS.filter(j => j.id.startsWith('queue:')).map(j => j.id.slice('queue:'.length)))
  const found = new Set<string>()
  const scan = (dir: string) => {
    for (const e of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'queue') scan(p); continue }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue
      const src = readFileSync(new URL(p, import.meta.url), 'utf8')
      for (const m of src.matchAll(/enqueue\(\{[^}]*?kind:\s*'([a-z-]+)'/g)) found.add(m[1])
    }
  }
  scan('../lib'); scan('../app')
  assert.deepEqual([...found].filter(k => !kinds.has(k)).sort(), [], 'enqueued kinds with no manifest entry')
})

// The test's own source plus any test/helpers runtime it spawns (route-level suites drive the worker through the
// real tick route in a child process, so the worker's name appears in the helper, not the test).
const testSrc = (file: string) => {
  const url = new URL(`./${file}`, import.meta.url)
  if (!existsSync(url)) return null
  let src = readFileSync(url, 'utf8')
  for (const m of src.matchAll(/test\/helpers\/[A-Za-z0-9._-]+/g)) {
    const h = new URL(`./helpers/${m[0].split('/').pop()}`, import.meta.url)
    if (existsSync(h)) src += '\n' + readFileSync(h, 'utf8')
  }
  return src
}

for (const job of JOBS) {
  const iso = job.isolation
  if ('covered' in iso) {
    const covered = iso.covered
    test(`${job.id}: ${covered} names a real two-tenant test of ${job.worker}`, () => {
      const src = testSrc(covered)
      assert.ok(src, `${covered} does not exist`)
      assert.ok(src.includes(job.worker) || job.worker === 'runJob', `${covered} never exercises ${job.worker}`)
      const names = [...src.matchAll(/(?:test|it|bothEngines)\(\s*'([^']+)'/g)].map(m => m[1])
      assert.ok(names.some(n => TWO_TENANT_NAME.test(n)), `${covered} has no test whose name proves two-tenant isolation`)
    })
  } else {
    const reason = iso.global, file = iso.test, via = iso.via
    test(`${job.id}: ${job.worker} global maintenance is bounded and gated (${file})`, () => {
      assert.ok(reason.length > 40, 'a global entry must state why cross-tenant harm is impossible')
      const src = testSrc(file)
      assert.ok(src, `${file} does not exist`)
      assert.ok(src.includes(job.worker) || (via !== undefined && src.includes(via)), `${file} never exercises ${job.worker}`)
    })
  }
}
