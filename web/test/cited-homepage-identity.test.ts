import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'

// Prod run c4d2fd9c: every source was an aggregator list (landbase, roledawn) that links no company site, so the site lookup only
// guessed <name>.com/.io and refused them all. A scan citation is admitted only when the lead's own publisher
// pairs that exact company and domain without a link. The homepage still has to pass identity/place checks.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We help revenue teams find and book meetings with the right buyers, and we care about every customer we work with every single day.</p>'
const exactQuote = (host: string) => `LevelUp Leads (${host}) is hiring its first Sales Development Representative.`
const LIST = (q: string) => html(`<h1>Companies hiring their first SDR</h1><p>${q}</p><a href="/other">More lists</a>`)

const HOME = (name: string) => html(`<title>${name}</title>${name} - outbound pipeline for B2B teams. ${PROSE}<a href="/contact">Contact</a>`)
const CONTACT = html('<a href="mailto:hello@levelupleads.io">hello</a>')

async function run(citedUrls: string[] | undefined, homeName = 'LevelUp Leads', domain = 'levelupleads.org', sourceHtml?: string) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'LevelUp Leads', null, 'Hiring its first SDR', 'https://lists.example/first-sdr', exactQuote(domain), 90, 85)
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'lists.example') return { status: 200, body: sourceHtml ?? LIST(exactQuote(domain)), finalUrl: url }
    if (!['levelupleads.io', 'levelupleads.org', 'lul-growth.io'].includes(u.hostname.replace(/^www\./, ''))) return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    const b = ({ '/': HOME(homeName), '/contact': CONTACT } as Record<string, string>)[u.pathname]
    return b !== undefined ? { status: 200, body: b, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-21T09:00:00Z'), ...(citedUrls ? { citedUrls } : {}) })
  return {
    domain: (db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain,
    audit: db.prepare("SELECT lookup, status FROM connector_audit WHERE connector = 'sitecrawl'").all() as { lookup: string; status: string }[],
  }
}

test('an exact publisher quote pairs the lead with a cited domain and the homepage confirms the company', async () => {
  const r = await run(['https://lists.example/first-sdr', 'https://www.levelupleads.org/about'])
  assert.equal(r.domain, 'levelupleads.org', JSON.stringify(r.audit))
})
test('without the cited homepage the same lead stays unresolved (main behaviour)', async () => {
  assert.equal((await run(undefined)).domain, null)
})
test('a cited site whose domain is not the company name is never taken', async () => {
  assert.equal((await run(['https://lul-growth.io/'])).domain, null)
})
test('a cited same-label homepage that does not name the company is refused (name proof)', async () => {
  const r = await run(['https://levelupleads.io/'], 'Totally Different Co', 'levelupleads.io')
  assert.equal(r.domain, null, JSON.stringify(r.audit))
})
test('review: a cited same-name homepage in another city than the evidence names is refused, and guesses still run after it', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'LevelUp Leads', null, 'Hiring its first SDR', 'https://lists.example/first-sdr', 'LevelUp Leads (levelupleads.io), based in Austin, TX, is hiring its first SDR.', 90, 85)
  const seen: string[] = []
  const get: Get = async url => {
    const u = new URL(url); seen.push(u.hostname)
    if (u.hostname === 'lists.example') return { status: 200, body: html('<p>LevelUp Leads (levelupleads.io), based in Austin, TX, is hiring its first SDR.</p>'), finalUrl: url }
    if (u.hostname.replace(/^www\./, '') !== 'levelupleads.io') return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: html(`<title>LevelUp Leads</title>LevelUp Leads, Leeds, United Kingdom. ${PROSE}`), finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-21T09:00:00Z'), citedUrls: ['https://levelupleads.io/'] })
  assert.equal((db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain, null)
  assert.ok(seen.some(h => /^(?:www\.)?levelup(?:leads)?\.com$/.test(h) || h.endsWith('.com')), JSON.stringify([...new Set(seen)]))
})


test('two leads in one scan cannot share a cited site through normalized names', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); migrateConnectors(db)
    const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
    db.prepare("UPDATE scan_jobs SET status='running', icp=? WHERE id=?").run(JSON.stringify({ summary:'s', where:[] }),job)
    const actual = 'Everstone Holdings (everstone.org) is hiring its first account executive.'
    const mistaken = 'Everstone is searching for a senior sales manager.'
    const insert = db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?)')
    const ownerSource = 'https://listings.example/holdings'
    const otherSource = 'https://listings.example/company'
    insert.run('owner',job,'Everstone Holdings','Hiring',ownerSource,actual,90,90)
    insert.run('other',job,'Everstone','Hiring',otherSource,mistaken,90,80)
    const get: Get = async url => {
      const u = new URL(url)
      if (url === ownerSource) return { status:200, body:LIST(actual), finalUrl:url }
      // The other source names both companies in different blocks. Only its matching lead's own quote counts.
      if (url === otherSource) return { status:200, body:html(`<p>${mistaken}</p><p>${actual}</p>`),finalUrl:url }
      if (u.hostname.replace(/^www\./,'') !== 'everstone.org') return null
      if (u.pathname === '/robots.txt') return { status:200, body:'User-agent: *\nAllow: /', finalUrl:url }
      if (u.pathname === '/') return { status:200, body:HOME('Everstone Holdings'), finalUrl:url }
      return { status:404,body:'',finalUrl:url }
    }
    await crawlJob(db,'A',job,{ get,gapMs:0,env:{},citedUrls:['https://everstone.org/'],redirectOf:async()=>null })
    assert.deepEqual(db.prepare('SELECT id,company_domain FROM leads WHERE scan_job_id=? ORDER BY id').all(job),[
      { id:'other',company_domain:null },{ id:'owner',company_domain:'everstone.org' },
    ])
    assert.deepEqual(db.prepare("SELECT lead_id,source_url FROM lead_enrichments WHERE kind='domain' ORDER BY lead_id").all(),[
      { lead_id:'owner',source_url:ownerSource },
    ])
  } finally { db.close() }
})

test('a quoted domain inside a larger company name is not attributable', async () => {
  const r = await run(['https://levelupleads.org/'], 'LevelUp Leads', 'levelupleads.org', LIST('North ' + exactQuote('levelupleads.org')))
  assert.equal(r.domain,null)
})

test('a hidden publisher attribution is not evidence', async () => {
  const r = await run(['https://levelupleads.org/'], 'LevelUp Leads', 'levelupleads.org', html(`<div hidden><p>${exactQuote('levelupleads.org')}</p></div>`))
  assert.equal(r.domain,null)
})

test('review (Qodo High): a cited homepage whose label also fits another lead in the scan is not taken by the shorter name', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: [] }), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
  ins.run('L1', job, 'LevelUp', null, 'Hiring its first SDR', 'https://lists.example/first-sdr', 'LevelUp is hiring its first Sales Development Representative.', 90, 85)
  ins.run('L2', job, 'LevelUp Leads', null, 'Hiring its first SDR', 'https://lists.example/first-sdr', 'LevelUp Leads is hiring its first Sales Development Representative.', 90, 85)
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'lists.example') return { status: 200, body: LIST('LevelUp Leads is hiring its first Sales Development Representative.'), finalUrl: url }
    if (u.hostname.replace(/^www\./, '') !== 'levelup.org') return null
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: HOME('LevelUp Leads'), finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-21T09:00:00Z'), citedUrls: ['https://levelup.org/'] })
  assert.equal((db.prepare('SELECT company_domain FROM leads WHERE id = ?').get('L1') as { company_domain: string | null }).company_domain, null)
})

test('a sole lead cannot claim a namesake domain cited for an absent organization', async () => {
  const r = await run(['https://levelupleads.org/'], 'LevelUp Leads Holdings', 'levelupleads.org',
    LIST('LevelUp Leads is hiring its first Sales Development Representative.'))
  assert.equal(r.domain, null, JSON.stringify(r.audit))
})
