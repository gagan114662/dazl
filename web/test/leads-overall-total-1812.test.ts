import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

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

test('#1812: the sidebar latest-search redirect keeps the workspace total visible', () => {
  const sidebar = read('../app/app/nav.tsx').match(/href: '(\/app\/leads\?latest=1)', label: 'Leads'/)?.[1]
  assert.ok(sidebar, 'sidebar Leads entry')
  const redirect = leads.match(/else (if \(params\.get\('latest'\)[\s\S]*?\n      \})/)?.[1]
  assert.ok(redirect, 'latest-search redirect')
  const destinations: string[] = []
  const id = 'a'.repeat(24)
  runInNewContext(redirect, {
    params: new URL(sidebar, 'https://example.com').searchParams,
    jobs: [{ id, status: 'done', lead_count: 1 }],
    window: { location: { replace: (url: string) => destinations.push(url) } },
  })
  assert.deepEqual(destinations, [`/app/leads?job_id=${id}`])

  const effect = leads.match(/const \[ready, setReady\][\s\S]*?const \[pastJobs, setPastJobs\]/)?.[0]
  assert.ok(effect, 'workspace count read')
  assert.ok(!effect.includes('if (jobId) return'), 'a search deep link also loads the workspace counts')
  assert.ok(/\{ready && \(\s*<p[^>]*data-testid="leads-overall-total"/.test(leads),
    'the workspace total is visible while viewing an individual search')
})
