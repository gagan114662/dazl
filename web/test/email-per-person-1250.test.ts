// #1250: the matrix email column scores PER PERSON. A lead counts only when a named person on it has their OWN address on the
// company's own domain (the site the crawl confirmed, leads.company_domain): printed on that site and filed under that person by the
// crawl (email_candidates, tier 'published'), or an address on the lead whose local part carries that person's name. A role inbox
// (hello@ / info@) never stands in for a person; a labelled guess is shown in its own column and never counted.
// Real prod shapes from the issue (measured 2026-11-14 on #1036): toronto-dental's Don River Dental Clinic scored email 100% with
// nobody named (hello@ + info@donriverdental.com from the site crawl); chicago-law's Benesch CMO, whose own address is printed on
// beneschlaw.com/contact-us/ and recorded as a published candidate, scored 0. The person's first name is anonymised.
// Everything is written through the real store and the crawl's own writer (recordEmailGuesses); no network, no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { migrateEmailGuess, recordEmailGuesses } from '../lib/people/email-pattern.ts'
import { measureCase } from '../scripts/matrix-score.mts'

const NOW = Math.floor(Date.now() / 1000)
const expect = { location_keywords: ['toronto', 'chicago'], category_keywords: ['dental', 'law'] }

function seed() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEmailGuess(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES ('j1', 'A', 'x', '(from request)', '-', 'Dental clinics and law firms', 'running', 9, ?)").run(NOW)
  const lead = (id: string, o: { company: string; name?: string; contact?: string | null; domain?: string | null }) =>
    db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, company_domain, created_at) VALUES (?, 'j1', ?, ?, ?, 'Opened a new location', ?, ?, ?)")
      .run(id, o.company, o.name ?? '', o.contact ?? null, `https://news.example/${id}`, o.domain ?? null, NOW)
  const enrich = (leadId: string, kind: string, value: string, url: string) =>
    addEnrichment(db, 'A', leadId, { connector: 'sitecrawl', kind, value, label: null, confidence: null, source_url: url, source_date: '2026-11-14', retrieved_at: NOW })
  return { db, lead, enrich }
}
const only = (db: Database.Database) => { db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run(); return measureCase(db, 'A', 'j1', { expect }) }

test('#1250 prod: role inboxes with nobody named are not a person email (Don River Dental Clinic: hello@ + info@)', () => {
  const { db, lead, enrich } = seed()
  lead('don', { company: 'Don River Dental Clinic', domain: 'donriverdental.com' })
  enrich('don', 'email', 'hello@donriverdental.com', 'https://donriverdental.com/contact')
  enrich('don', 'email', 'info@donriverdental.com', 'https://donriverdental.com/contact')
  const m = only(db)
  assert.equal(m.email_pct, 0, 'was 100%: a role inbox never counts as the buyer\'s email')
  assert.equal(m.email_role_pct, 100, 'shown as role inbox only')
  assert.equal(m.email_guess_pct, 0)
})

test('#1250 prod: a named buyer\'s own address printed on the company\'s site counts (Benesch CMO, published candidate)', () => {
  const { db, lead, enrich } = seed()
  lead('ben', { company: 'Benesch', domain: 'beneschlaw.com' })
  const person = 'Jo Hammerstrom, Chief Marketing Officer'
  enrich('ben', 'person', person, 'https://www.beneschlaw.com/contact-us/')
  // the crawl's own writer files the printed address under this person (published tier, the page it was printed on)
  const r = recordEmailGuesses(db, 'A', 'ben', 'beneschlaw.com', [], [person], { env: {}, homeText: '127 Public Square, Cleveland, OH 44114', seen: [{ address: 'jhammerstrom@beneschlaw.com', url: 'https://www.beneschlaw.com/contact-us/' }] })
  assert.equal(r?.published, 1, 'the crawl recorded the published candidate')
  const m = only(db)
  assert.equal(m.email_pct, 100, 'was 0: the scorer did not read the published candidate')
  assert.equal(m.email_role_pct, 0); assert.equal(m.email_guess_pct, 0)
})

test('#1250: per person, on the company\'s own domain, never a role inbox, another person, another domain or a guess', () => {
  const { db, lead, enrich } = seed()
  lead('own', { company: 'Smile Dental', name: 'Dana Lee', contact: 'dana.lee@smile.example', domain: 'smile.example' })          // counts
  lead('site', { company: 'Pine Dental', domain: 'pine.example' })                                                                 // counts: site person + their own address
  enrich('site', 'person', 'Priya Nair, Practice Owner', 'https://pine.example/team')
  enrich('site', 'email', 'priya@pine.example', 'https://pine.example/team')
  lead('role', { company: 'Oak Dental', name: 'Sam Park', contact: 'info@oak.example', domain: 'oak.example' })                    // role inbox only
  lead('other', { company: 'Elm Dental', name: 'Ana Cruz', contact: 'pat.kim@elm.example', domain: 'elm.example' })                // someone else's mailbox
  lead('offsite', { company: 'Birch Dental', name: 'Lee Wong', contact: 'lee.wong@gmail.example', domain: 'birch.example' })      // not the company's domain
  lead('nodomain', { company: 'Ash Dental', name: 'Kim Roy', contact: 'kim.roy@ash.example' })                                    // no confirmed site
  lead('guess', { company: 'Fir Dental', name: 'Tom Hale', domain: 'fir.example' })                                                // a labelled guess only
  db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, tier, confidence) VALUES ('A', 'guess', 'Tom Hale', 'tom.hale@fir.example', 'first.last', 'guessed', 'high')").run()
  lead('nobody', { company: 'Yew Dental', contact: 'dana.lee@yew.example', domain: 'yew.example' })                               // an address, but nobody named
  const m = only(db)
  assert.equal(m.leads, 8)
  assert.equal(m.email_pct, 25, 'own and site only: 2 of 8')
  assert.equal(m.email_role_pct, 13, 'role: 1 of 8')
  assert.equal(m.email_guess_pct, 13, 'guess: 1 of 8, shown, never counted')
})
