// #1571 (Quest on staging 8132d324): every discovery lead's card said "the company's own website was not identified" beside a contact,
// while the same card's Details and Website link showed the website the run had found.
//
// The whole path, nothing injected: the discovery lane stores the leads (real runJob, canned loop answer, no network), the real
// GET /api/leads handler reads them back, lib/scan/lead-card.ts builds the card from that row, and the real header component
// (app/app/leads/contact-status.tsx, the one the Leads page renders) is rendered with react-dom/server.
//
// What the header must say, decided before the change (black-box, per stored lead):
//   1. a discovery lead with a stored website that is a host name: the header names THAT website as identified, the same value the
//      row carries for Details and the Website link. It never says "not identified". It never reads as confirmed: no "Confirmed",
//      no "Source confirmed" mark, and it says the site is not confirmed as the company's own.
//   2. a discovery lead with no stored website: "the company's own website was not identified", as before.
//   3. a discovery lead whose stored value is not a host name: the same as 2.
//   4. a lead that is not from the discovery lane: its header is word for word what it was.
//   5. Approve is not touched: what could be approved before can be approved after, and nothing else can.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { createQueryJob } from '../../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../../lib/scan/runner.ts'
import { leadCardSummary } from '../../lib/scan/lead-card.ts'
import type { DiscoverResult, DiscoveredLead } from '../../lib/discover/agent.ts'
import { ContactStatusLine } from '../../app/app/leads/contact-status.tsx'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const lead = (company: string, o: Partial<DiscoveredLead>): DiscoveredLead => ({ company, domain: null, signal: 'Opening a second clinic', signal_date: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), evidence_url: `https://news.example/${company.toLowerCase().replace(/\W+/g, '-')}`, evidence_quote: `${company} will open its second clinic`, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'expanding', ...o })
const NONE = 'Unconfirmed - the company\'s own website was not identified.'
const unescape = (s: string) => s.replace(/&#x27;|&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

test('#1571 the card header names the website a discovery lead carries; no website, or not a host name, stays "not identified"; other leads are unchanged', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:'); migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  setScanDb(db); setUser({ id: 'T', business_name: 'Fit-out Co' })
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const leads = [
    lead('Northwind Dental', { domain: 'northwind-dental.example', person: 'Dana Ruiz', title: 'Practice Owner', person_source_url: 'https://northwind-dental.example/team', email: 'dana@northwind-dental.example', email_source_url: 'https://northwind-dental.example/contact' }),
    lead('Harbour Smiles', { domain: null, person: 'Sam Lee', title: 'Owner', person_source_url: 'https://news.example/harbour-smiles' }),
    lead('Cedar Dental', { domain: 'not a domain', person: 'Kim Park', title: 'Owner', person_source_url: 'https://news.example/cedar-dental' }),
  ]
  const canned: DiscoverResult = { leads, seen: leads.map(l => ({ url: l.evidence_url, title: l.company, page_age: null, text: `${l.company} will open its second clinic. The opening was announced on ${l.signal_date}.` })),
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'claude-opus-5-5', note: null }
  canned.seen.push({ url: 'https://northwind-dental.example/contact', title: 'Contact', page_age: null, text: 'Dana Ruiz: dana@northwind-dental.example' })
  let asked = 0
  const blocked = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch
  assert.equal(await runJob(db, job!, { master, fetchImpl: blocked, discover: true, enrichImpl: null, discoverImpl: async () => (asked++ === 0 ? canned : { ...canned, leads: [], seen: [] }) }), 'done')

  // a lead of the older engine in another search of the same workspace: a contact, no recorded website
  const old = 'f'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES (?, 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run(old)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind) VALUES ('legacy', ?, '', 'Bright Dental', '+1 416 555 0100', 'Opening a second clinic', 'https://news.example/bright', 85, 'Bright Dental will open its second clinic', ?, 'verified', 85, 4, 4, 'expanding', 'news')").run(old, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(old)

  type Row = { id: string; company: string; company_domain: string | null; source_kind?: string | null; day_verified?: boolean }
  const read = async (jobId: string) => {
    const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${jobId}`))
    assert.equal(res.status, 200)
    return (await res.json() as { leads: Row[] }).leads
  }
  // what a person reads beside the contact: the real component, rendered from the real row
  const header = (row: Row) => {
    const card = leadCardSummary(row as never)
    const html = renderToStaticMarkup(h(ContactStatusLine, { status: card.contactStatus }))
    const m = /data-testid="contact-status"[^>]*>([^<]*)</.exec(html)
    return { text: m ? unescape(m[1]) : null, html, confirmed: card.contactStatus?.confirmed ?? null, approve: card.approve }
  }
  const rows = await read(id)
  const of = (company: string) => { const r = rows.find(x => x.company === company); assert.ok(r, `${company} is listed`); return r }

  // 1. a stored website: named as identified, the value the row carries; not "not identified", and not confirmed
  const nw = of('Northwind Dental'), a = header(nw)
  assert.deepEqual([nw.source_kind, nw.company_domain], ['discover', 'northwind-dental.example'], 'the lane stored the website on the lead')
  assert.equal(a.text, 'Website identified: northwind-dental.example. Not confirmed as the company\'s own site.')
  assert.ok(a.text!.includes(nw.company_domain!), 'the header names the same website Details and the Website link use')
  assert.equal(a.confirmed, false)
  assert.ok(!/Confirmed|Source confirmed/.test(a.html), 'identified is not ownership-verified')
  // 5. Approve is as it was for this lead (a dated signal, an address its own site prints)
  assert.equal(nw.day_verified, true, 'the read page states the exact day')
  assert.deepEqual(a.approve, { ok: true })
  // 2. no stored website
  const hs = of('Harbour Smiles')
  assert.equal(hs.company_domain, null)
  assert.equal(header(hs).text, NONE)
  // 3. a stored value that is not a host name
  const cd = of('Cedar Dental')
  assert.equal(cd.company_domain, 'not a domain')
  assert.equal(header(cd).text, NONE)
  // 4. the older engine's lead: word for word what it was
  const legacy = (await read(old)).find(r => r.id === 'legacy')
  assert.ok(legacy)
  assert.equal(header(legacy).text, NONE)
})
