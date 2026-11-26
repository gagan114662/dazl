import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { migrateEmailGuess, personalAddresses, publishedCandidateFor, recordEmailGuesses } from '../lib/people/email-pattern.ts'

// Recorded visible profile excerpts. The selection has no US ZIP proof.
const pages = [
  { where: ['Dubai, United Arab Emirates'], home: 'Dubai', site: 'akingump.com',
    url: 'https://www.akingump.com/en/lawyers-advisors/graham-lovett', name: 'Graham Lovett', title: 'Partner',
    text: 'Graham Lovett\nPartner, Commercial Arbitration & Litigation\nSend Email (glovett@akingump.com)',
    address: 'glovett@akingump.com', basis: 'scan geography names AE' },
  { where: ['United Kingdom'], home: 'North London', site: 'pellings.co.uk',
    url: 'https://pellings.co.uk/contact-us/management-directory/', name: 'Mark Brown', title: 'Managing Director',
    text: 'Mark Brown BSc (Hons) MRICS\nManaging Director\nSend email (mbrown@pellings.co.uk)',
    address: 'mbrown@pellings.co.uk', basis: 'scan geography names GB' },
  { where: ['Australia'], home: 'Sydney', site: 'bartier.com.au',
    url: 'https://www.bartier.com.au/our-team/darren-gardner', name: 'Darren Gardner', title: 'Partner',
    text: 'Darren Gardner\nPartner*\nView contact details +\ndgardner@bartier.com.au',
    address: 'dgardner@bartier.com.au', basis: 'scan geography names AU' },
  { where: ['United States'], home: 'Cleveland', site: 'beneschlaw.com',
    url: 'https://www.beneschlaw.com/contact-us/', name: 'Jeanne Hammerstrom', title: 'Chief Marketing Officer',
    text: 'Jeanne Hammerstrom\nChief Marketing Officer\nCleveland\njhammerstrom@beneschlaw.com',
    address: 'jhammerstrom@beneschlaw.com', basis: 'no US address on the homepage: country unknown' },
]

for (const page of pages) test(`published work email survives the geography gate: ${page.site}`, () => {
  const db = new Database(':memory:')
  try {
    const seen = personalAddresses(page.text, page.site).map(({ address }) => ({ address, url: page.url }))
    assert.deepEqual(seen, [{ address: page.address, url: page.url }])
    const result = recordEmailGuesses(db, 'tenant', 'lead', page.site, [], [`${page.name}, ${page.title}`],
      { env: {}, where: page.where, homeText: page.home, seen })
    assert.equal(result?.published, 1)
    assert.deepEqual(publishedCandidateFor(db, 'tenant', 'lead', page.name), { address: page.address, url: page.url })
    assert.deepEqual(db.prepare('SELECT country_basis, tier FROM email_candidates').get(),
      { country_basis: page.basis, tier: 'published' })
  } finally { db.close() }
})

test('foreign scope does not attach another person’s address, an off-site address, or a guess', () => {
  const db = new Database(':memory:')
  try {
    migrateEmailGuess(db)
    const page = pages[1]
    recordEmailGuesses(db, 'tenant', 'lead', page.site, ['cwong', 'aevans'], ['Casey Wong, Owner', 'Alex Evans, Director'], {
      env: { EMAIL_GUESS_ENABLED: '1' }, where: page.where, homeText: page.home,
      seen: [{ address: page.address, url: page.url },
        { address: 'cwong@elsewhere.example', url: page.url }],
    })
    assert.deepEqual(db.prepare('SELECT address FROM email_candidates').all(), [])
  } finally { db.close() }
})

// First-party visible copy, presented in a minimal crawl transport fixture.
// Preserve each page's recorded identity, title and address from the cases above.
const profiles = [
  { company: 'Akin Gump', prose: 'The Dubai office furthers Akin’s commitment to place subject matter experts on the ground where our clients are and also serves as a base to support the firm’s expanding Africa practice.' },
  { company: 'Pellings', prose: 'Pellings has been working as the Employer’s Agent and Clerk of Works for Sage Homes on the First Phase of the Meridian Water development, a major regeneration project in Enfield, North London. Pellings provided Quantity Surveying and Project Management services to restore traditional features to Beckenham Methodist Church, whilst also constructing a new modern space to be used by the local community as a cafe/shared space.' },
  { company: 'Bartier', prose: 'Darren is a trusted and valued consulting partner and legal adviser to employers in the corporate and government sectors. Darren is considered by many of his clients to be an integral part of their leadership team helping to deliver on important organisational change and effectiveness objectives.' },
  { company: 'Benesch Law', prose: 'Benesch represents a new standard of elite—a high-performing law firm that’s agile, modern and driven to deliver a better, more valuable experience for our clients and our people.' },
]

for (const [i, page] of pages.entries()) test(`company-first crawler attaches the exact published mailbox: ${page.site}`, async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const { company, prose } = profiles[i]
    const job = createJob(db, 'tenant', { business_name: 'Seller', industry: 'services', location: page.where[0] })
    db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?")
      .run(JSON.stringify({ who: [page.title], where: page.where }), job)
    const origin = 'https://' + page.site
    const source = origin + '/event'
    db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,90,80)')
      .run('lead', job, company, 'Hiring', source, company)
    const bodies: Record<string, string> = {
      '/robots.txt': 'User-agent: *\nAllow: /',
      '/': `<html><body><p>${company}, ${page.where[0]}</p><p>${prose}</p><a href="/team">Team</a></body></html>`,
      '/event': `<html><body><p>${company}</p><p>${prose}</p></body></html>`,
      '/team': `<html><body><p>${prose}</p><article><h2>${page.name}</h2><p>${page.title}</p><a href="mailto:${page.address}">${page.address}</a></article></body></html>`,
    }
    const get: Get = async url => {
      const target = new URL(url)
      const body = target.origin === origin ? bodies[target.pathname] : undefined
      return { status: body ? 200 : 404, body: body ?? '', finalUrl: url }
    }
    await crawlJob(db, 'tenant', job, { get, gapMs: 0, env: {}, companyFirstContacts: true })
    const rows = enrichmentsForLeads(db, 'tenant', ['lead']).lead ?? []
    assert.deepEqual(rows.filter(row => row.kind === 'person').map(row => row.value), [`${page.name}, ${page.title}`])
    assert.deepEqual(rows.filter(row => row.kind === 'email').map(row => [row.value, row.source_url]),
      [[page.address, origin + '/team']])
    assert.equal(db.prepare("SELECT COUNT(*) FROM email_candidates WHERE tier = 'guessed'").pluck().get(), 0)
  } finally { db.close() }
})
