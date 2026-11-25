import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const home = read('../app/app/home-results.tsx')
const leads = read('../app/app/leads/leads-client.tsx')
const homeReady = read('../app/api/home/ready/route.ts')

test('#1812: Home and Leads read the same workspace-ready endpoint', () => {
  const path = home.match(/fetch\('(\/api\/home\/ready)'/)?.[1]
  assert.equal(path, '/api/home/ready')
  assert.ok(leads.includes(`fetch('${path}'`))
  assert.match(homeReady, /await homeReady\(user\.tenantId\)/)
  assert.match(leads, /data-testid="leads-overall-total"/)
  assert.match(leads, /ready\.window_days/)
  assert.match(leads, /ready\.ready/)
  assert.match(leads, /ready\.judged/)
  assert.match(leads, /ready\.scans\.length/)
  assert.match(leads, /ready\.capped/)
})

test('#1812: a full history list offers the older searches control', () => {
  assert.ok(/pastJobs\.length >= 20[\s\S]+?Show older searches with ready leads/.test(leads))
  assert.match(leads, /ready\.scans\.filter\(scan => !listed\.has\(scan\.job_id\)\)/)
})

test('#1812: opening the latest search keeps the workspace total visible', () => {
  const effect = leads.match(/const \[ready, setReady\][\s\S]*?const \[pastJobs, setPastJobs\]/)?.[0]
  assert.ok(effect, 'workspace count read')
  assert.ok(!effect.includes('if (jobId) return'), 'a search deep link also loads the workspace counts')
  assert.ok(/\{ready && \(\s*<p[^>]*data-testid="leads-overall-total"/.test(leads),
    'the workspace total is visible while viewing an individual search')
})
