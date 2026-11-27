import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import type { DiscoverResult } from '../../lib/discover/agent.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { claimKeyedJob, runJob } from '../../lib/scan/runner.ts'
import { createQueryJob } from '../../lib/scan/store.ts'
import { setScanDb } from '../helpers/tenant-route-db.ts'

export async function verifySyntheticReadyBuyer(): Promise<void> {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    setScanDb(db)
    const tenant = 'T'
    const master = randomBytes(32)
    saveKey(db, tenant, 'anthropic', 'sk-ant-test', master)
    const company = 'Synthetic Fern Dental'
    const place = 'Austin, TX'
    const host = 'syntheticferndental.com'
    const origin = 'https://' + host
    const evidence = origin + '/careers'
    const signal = 'Hiring a Dental Receptionist'
    const quote = company + ' is hiring a Dental Receptionist in ' + place
    const day = new Date(Date.now() - 5 * 86_400_000)
    const posted = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(day)
    const address = 'dana.ruiz@' + host
    const jobId = createQueryJob(db, tenant, { query: 'Dentists in ' + place, seller: 'Dental supplies' })
    db.prepare('UPDATE scan_jobs SET icp = ?, icp_inferred = 1 WHERE id = ?')
      .run(JSON.stringify({ who: ['Practice Manager'], where: [place] }), jobId)
    const job = claimKeyedJob(db, jobId)
    assert.ok(job)
    const found: DiscoverResult = {
      leads: [{ company, domain: host, signal, signal_date: day.toISOString().slice(0, 10), evidence_url: evidence,
        evidence_quote: quote, person: null, title: null, person_source_url: null, linkedin_url: null,
        email: null, email_source_url: null, confidence: 'high', why: 'hiring' }],
      seen: [{ url: evidence, title: company, page_age: null, text: null }],
      usage: { input_tokens: 1_000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 },
      stop: 'end_turn', model: 'claude-opus-5-5', note: null,
    }
    const pages = new Map([
      [evidence, '<html><body>Posted on ' + posted + '. ' + quote + ' <a href="' + origin + '/">Synthetic Fern Dental</a></body></html>'],
      [origin + '/robots.txt', 'User-agent: *\nAllow: /'],
      [origin + '/', '<html><body><h1>Synthetic Fern Dental</h1><p>100 Example Avenue, Austin, TX 78702, United States.</p><a href="/team">Our team</a></body></html>'],
      [origin + '/team', '<html><body><p>Our local clinic has served the neighbourhood for many years. We welcome new patients and offer appointments for families throughout the week.</p><article><h2>Dana Ruiz</h2><p>Practice Manager</p><a href="mailto:' + address + '">' + address + '</a></article></body></html>'],
    ])
    const verificationReads = new Set<string>()
    const crawlReads = new Set<string>()
    assert.equal(await runJob(db, job, {
      master, discover: true, discoverImpl: async () => found, enrichImpl: null,
      fetchImpl: async input => {
        verificationReads.add(String(input))
        const page = pages.get(String(input))
        return new Response(page ?? '', { status: page ? 200 : 404 })
      },
      crawlGet: async url => {
        crawlReads.add(url)
        return { status: pages.has(url) ? 200 : 404, body: pages.get(url) ?? '', finalUrl: url }
      },
    }), 'done')
    assert.ok(verificationReads.has(evidence), 'Discovery verifies the fetched posting')
    assert.ok(crawlReads.has(origin + '/team'), 'Discovery crawls the buyer’s team page')
    assert.ok(db.prepare("SELECT 1 FROM lead_enrichments WHERE tenant_id = ? AND kind = 'email' AND value = ? AND source_url = ?")
      .get(tenant, address, origin + '/team'), 'the recovered email cites the team page')
    const result = await homeReady(tenant, Math.floor(Date.now() / 1_000))
    assert.equal(result.judged, 1)
    assert.equal(result.ready, 1, JSON.stringify({ companies: result.companies,
      crawl: db.prepare('SELECT url FROM crawl_pages WHERE scan_job_id = ?').all(jobId),
      contacts: db.prepare('SELECT kind, connector, value FROM lead_enrichments').all(),
    }))
    const ready = result.companies.filter(lead => lead.ready)
    const saved = db.prepare('SELECT id FROM leads WHERE scan_job_id = ?').get(jobId) as { id: string }
    assert.deepEqual(ready.map(lead => lead.lead_id), [saved.id])
    assert.deepEqual(result.scans, [{ job_id: jobId, ready: 1 }])
    assert.equal(result.companies[0]?.details?.day_verified, true)
    assert.equal(result.companies[0]?.details?.contact_name, 'Dana Ruiz')
    assert.equal(result.companies[0]?.details?.email, address)
  } finally {
    db.close()
  }
}
