import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// Issue #2131: Calgary scan (b2ab19c9) has 6 leads, all rejected at contact-finding because
// `where.length === 0` (no place data from evidence). When the source is a job board, and the
// job board's ATS record names a domain for that company, the domain should be confirmed
// without requiring location evidence.
//
// The fix: When a job board (Ashby, Greenhouse, Lever) ATS record explicitly names a domain
// for the company (evidence_link_domain_label basis), bypass the location requirement.

const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We are building the future of cloud infrastructure.</p>'
const UUID = '7387a987-24f3-424c-8dd3-bb7ed16f95e0'

async function runJobBoardLead(opts: {
  sourceUrl: string
  atsDescription: string  // The ATS record description - should name the domain
  homeName?: string
  icpWhere?: string[]
  evidenceExcerpt?: string
  company?: string
  domain?: string
}) {
  const company = opts.company ?? 'CloudStack'
  const domain = opts.domain ?? 'cloudstack.io'
  const db = new Database(':memory:')
  migrateScan(db)
  migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(
    JSON.stringify({ summary: 's', where: opts.icpWhere ?? [] }),
    job
  )
  db.prepare(
    'INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,event_date,event_date_proof) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'L1',
    job,
    company,
    null,
    'Hiring a Sales Development Representative',
    opts.sourceUrl,
    opts.evidenceExcerpt ?? 'Sales Development Representative',
    90,
    85,
    '2026-11-13',
    'ats_structured'
  )

  const get: Get = async (url) => {
    const u = new URL(url)
    
    // Ashby posting page - returns JS shell
    if (u.hostname === 'jobs.ashbyhq.com' && u.pathname.includes(UUID)) {
      return {
        status: 200,
        body: '<html><head><title>Jobs</title></head><body><div id="root"></div></body></html>',
        finalUrl: url,
      }
    }
    
    // Ashby API - returns job record with the company domain in description
    if (u.hostname === 'api.ashbyhq.com') {
      const orgMatch = u.pathname.match(/\/posting-api\/job-board\/([^/]+)/)
      if (orgMatch) {
        return {
          status: 200,
          body: JSON.stringify({
            jobs: [{
              id: UUID,
              isListed: true,
              title: 'Sales Development Representative',
              publishedAt: '2026-11-13T21:24:44Z',
              descriptionPlain: opts.atsDescription,
              descriptionHtml: `<p>${opts.atsDescription}</p>`,
              jobUrl: opts.sourceUrl
            }]
          }),
          finalUrl: url,
        }
      }
    }
    
    // Greenhouse posting page
    if (u.hostname === 'boards.greenhouse.io' || u.hostname === 'job-boards.greenhouse.io') {
      return {
        status: 200,
        body: '<html><head><title>Jobs</title></head><body><div id="root"></div></body></html>',
        finalUrl: url,
      }
    }
    
    // Greenhouse API
    if (u.hostname === 'boards-api.greenhouse.io') {
      return {
        status: 200,
        body: JSON.stringify({
          id: 12345678,
          title: 'Sales Development Representative',
          content: opts.atsDescription,
          first_published: '2026-11-13T00:00:00Z',
          location: { name: '' }
        }),
        finalUrl: url,
      }
    }
    
    // Lever posting page
    if (u.hostname === 'jobs.lever.co') {
      return {
        status: 200,
        body: '<html><head><title>Jobs</title></head><body><div id="root"></div></body></html>',
        finalUrl: url,
      }
    }
    
    // Lever API
    if (u.hostname === 'api.lever.co') {
      return {
        status: 200,
        body: JSON.stringify({
          id: UUID,
          text: 'Sales Development Representative',
          descriptionPlain: opts.atsDescription,
          createdAt: Date.parse('2026-11-13T00:00:00Z'),
          categories: { location: '' }
        }),
        finalUrl: url,
      }
    }
    
    // Company website - match the domain from the ATS record
    const host = u.hostname.replace(/^www\./, '')
    if (host === domain) {
      if (u.pathname === '/robots.txt') {
        return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
      }
      if (u.pathname === '/') {
        const homeName = opts.homeName ?? company
        return {
          status: 200,
          body: html(`<title>${homeName}</title>${homeName} ${PROSE}<a href="/contact">Contact</a>`),
          finalUrl: url,
        }
      }
      return { status: 404, body: '', finalUrl: url }
    }
    
    return null
  }

  await crawlJob(db, 'A', job, {
    get,
    gapMs: 0,
    env: {},
    redirectOf: async () => null,
    now: Date.parse('2026-11-21T09:00:00Z'),
  })

  return {
    domain: (
      db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as {
        company_domain: string | null
      }
    ).company_domain,
    audit: db
      .prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'")
      .all() as { lookup: string; status: string }[],
    rejections: db
      .prepare(
        "SELECT value FROM lead_enrichments WHERE lead_id = 'L1' AND kind = 'contact_rejected'"
      )
      .all() as { value: string }[],
  }
}

test('#2131: Ashby job board lead with domain in ATS record and no geography should be confirmed', async () => {
  // The ATS record explicitly names cloudstack.io
  const r = await runJobBoardLead({
    sourceUrl: `https://jobs.ashbyhq.com/cloudstack/${UUID}`,
    atsDescription: 'ABOUT CLOUDSTACK CloudStack is building the future. Learn more at cloudstack.io.',
    icpWhere: [], // No geography
    evidenceExcerpt: 'Sales Development Representative',
  })

  assert.equal(
    r.domain,
    'cloudstack.io',
    `Domain should be confirmed. Rejections: ${JSON.stringify(r.rejections)}. Audit: ${JSON.stringify(r.audit)}`
  )
  assert.ok(
    !r.rejections.some((x) => x.value.includes('no location to confirm')),
    'Should not have location rejection when ATS record names the domain'
  )
})

test('#2131: Greenhouse job board lead with domain in ATS record and no geography should be confirmed', async () => {
  const r = await runJobBoardLead({
    sourceUrl: 'https://boards.greenhouse.io/cloudstack/jobs/12345678',
    atsDescription: '<p>Learn more about CloudStack at <a href="https://cloudstack.io">cloudstack.io</a></p>',
    icpWhere: [],
  })

  assert.equal(
    r.domain,
    'cloudstack.io',
    `Greenhouse lead should be confirmed. Rejections: ${JSON.stringify(r.rejections)}`
  )
})

test('#2131: Lever job board lead with domain in ATS record and no geography should be confirmed', async () => {
  const r = await runJobBoardLead({
    sourceUrl: `https://jobs.lever.co/cloudstack/${UUID}`,
    atsDescription: 'Visit us at cloudstack.io for more information about CloudStack.',
    icpWhere: [],
  })

  assert.equal(
    r.domain,
    'cloudstack.io',
    `Lever lead should be confirmed. Rejections: ${JSON.stringify(r.rejections)}`
  )
})

test('non-job-board lead with no geography should still be rejected', async () => {
  // Regular news article URL - NOT a job board
  const db = new Database(':memory:')
  migrateScan(db)
  migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(
    JSON.stringify({ summary: 's', where: [] }),
    job
  )
  db.prepare(
    'INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('L1', job, 'CloudStack', null, 'CloudStack is hiring', 'https://news.example.com/cloudstack-hiring', 'CloudStack is hiring', 90, 85)

  const get: Get = async (url) => {
    const u = new URL(url)
    if (u.hostname === 'news.example.com') {
      return { status: 200, body: '<html><body><h1>CloudStack is Hiring</h1></body></html>', finalUrl: url }
    }
    const host = u.hostname.replace(/^www\./, '')
    if (host.startsWith('cloudstack')) {
      if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
      if (u.pathname === '/') return { status: 200, body: html('<title>CloudStack</title>CloudStack builds cloud infrastructure.'), finalUrl: url }
      return { status: 404, body: '', finalUrl: url }
    }
    return null
  }

  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-21T09:00:00Z') })

  const domain = (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain
  const audit = db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[]

  assert.equal(domain, null, 'Non-job-board lead with no geo should remain unconfirmed')
  assert.ok(
    audit.some((a) => a.status.includes('no location to confirm')),
    `Should have location rejection. Audit: ${JSON.stringify(audit)}`
  )
})

test('job board lead WITHOUT domain in ATS record should still be rejected', async () => {
  // The ATS record does NOT name any domain
  const r = await runJobBoardLead({
    sourceUrl: `https://jobs.ashbyhq.com/cloudstack/${UUID}`,
    atsDescription: 'ABOUT CLOUDSTACK CloudStack is building the future of cloud infrastructure.',  // No domain mentioned!
    icpWhere: [],
    evidenceExcerpt: 'Sales Development Representative',
  })

  // Name probes should still be rejected without explicit domain evidence
  assert.equal(
    r.domain,
    null,
    `Domain should NOT be confirmed when ATS record doesn't name it. Audit: ${JSON.stringify(r.audit)}`
  )
})
