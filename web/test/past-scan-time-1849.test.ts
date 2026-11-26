import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('#1849: two same-day runs of the same query show distinct local times', () => {
  const source = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const expression = source.match(/<dt>Last run<\/dt><dd>\{([^}]+(?:\}[^}]+)?)\}<\/dd>/)?.[1]
  assert.ok(expression, 'the Past scans row renders the run date')
  assert.match(source, /pastJobs\.map\(j =>[\s\S]+?<div key=\{j\.id\}/)
  const query = 'Find teams looking for an installation service'
  const jobs = [
    { id: 'a'.repeat(24), query, created_at: new Date(2026, 10, 25, 7, 39, 13).getTime() / 1000 },
    { id: 'b'.repeat(24), query, created_at: new Date(2026, 10, 25, 7, 41, 39).getTime() / 1000 },
  ]
  const labels = jobs.map(j => runInNewContext(expression, { j, Date }))
  assert.notEqual(labels[0], labels[1])
  const formats = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const
  assert.deepEqual(labels, jobs.map(j => new Date(j.created_at * 1000).toLocaleString(undefined, formats)))
})
