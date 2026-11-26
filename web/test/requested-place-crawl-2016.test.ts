import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { enrichmentsForLeads, migrateConnectors } from '../lib/connectors/store.ts'
import { createQueryJob, migrateScan } from '../lib/scan/store.ts'

// Visible text transcribed from the linked first-party pages. HTML headings
// and links are the transport stub, not a recording of the original markup.
const dental = {
  company: 'Kwan', domain: 'drkwandentistry.com',
  home: 'Daphne Kwan | Toronto Family & Cosmetic Dentist. Please call 416-485-7121 for after-hour emergency dental services at our affiliate dental clinic Dental Emergency Services',
  contactPath: '/contact-us/',
  person: 'Daphne Kwan', title: 'Dentist', address: 'info@drkwandentistry.com',
  contactText: '', // https://drkwandentistry.com/contact-us/
}
const construction = {
  company: 'Lexen Engineering', domain: 'lexenengineering.com.au',
  home: 'Lexen Engineering Pty. Ltd. Based in Blacktown, NSW — Greater Sydney, Australia, and beyond.',
  contactPath: '/contact',
  person: 'Alexander Lundahan', title: 'CEO and Managing Director', address: 'alex@lexenengineering.com.au',
  contactText: 'Industrial maintenance and steel fabrication: mechanical engineering, engineering consultation, welding, custom fabrications, equipment installations (including pipe works), and breakdown and shutdown support.',
}

async function contacts(query: string, site: typeof dental) {
  const db = new Database(':memory:')
  try {
    migrateScan(db)
    migrateConnectors(db)
    const job = createQueryJob(db, 'tenant', { query })
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
    db.prepare(`INSERT INTO leads (id,scan_job_id,company,company_domain,signal,source_url,evidence_excerpt,confidence,score)
      VALUES ('lead',?,?,?,?,?,?,90,85)`).run(job, site.company, site.domain, 'Hiring',
      'https://publisher.example/posting', `${site.company} is hiring.`)
    const get: Get = async url => {
      const u = new URL(url)
      if (u.hostname.replace(/^www\./, '') !== site.domain) return null
      const body = u.pathname === '/robots.txt' ? 'User-agent: *\nAllow: /'
        : u.pathname === '/' ? `<p>${site.home}</p><a href="${site.contactPath}">Contact</a>`
        : u.pathname === site.contactPath ? `<p>${site.contactText}</p><h2>${site.person}</h2><p>${site.title}</p><a href="mailto:${site.address}">${site.address}</a>` : null
      return { status: body ? 200 : 404, body: body ?? '', finalUrl: url }
    }
    await crawlJob(db, 'tenant', job, { get, gapMs: 0, env: {}, textSites: [{ company: site.company, website: site.domain }] })
    return enrichmentsForLeads(db, 'tenant', ['lead']).lead ?? []
  } finally { db.close() }
}

test('#2016 saves Toronto from a typed request and attaches a first-party contact', async () => {
  const rows = await contacts('Dentists in Toronto that are hiring', dental)
  assert.ok(rows.some(row => row.kind === 'email' && row.value === dental.address), JSON.stringify(rows))
})

test('#2016 carries a country for an unrelated construction directory', async () => {
  const rows = await contacts('Engineering companies in Australia that are hiring', construction)
  assert.ok(rows.some(row => row.kind === 'person' && row.value.startsWith(construction.person)), JSON.stringify(rows))
})

test('#2016 still rejects a company in a different requested place', async () => {
  const rows = await contacts('Dentists in Vancouver that are hiring', dental)
  assert.ok(rows.some(row => row.kind === 'contact_rejected' && /location mismatch/i.test(row.value)), JSON.stringify(rows))
  assert.equal(rows.some(row => row.kind === 'person' || row.kind === 'email'), false)
})
