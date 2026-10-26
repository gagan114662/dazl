import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { parseWindowDays, splitByWindow } from '../lib/scan/window.ts'
import { normalizeIcp } from '../lib/scan/icp.ts'
import { recencyAnchor, claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, getJob, listLeads } from '../lib/scan/store.ts'
import type { Provider } from '../lib/llm/provider.ts'

// Issue #198 (confirmed in production): "past 90 days" was dropped from the profile and an April opening was returned
// as a top lead on 2026-10-26.
const NOW = new Date('2026-10-26T12:00:00Z')
const Q198 = 'Find independent dental practices in New York City that opened a new location or posted a front desk receptionist job in the past 90 days. Exclude chains and software vendors.'

test('the window is read from the request in several phrasings and languages; none means none', () => {
  assert.equal(parseWindowDays(Q198), 90)
  assert.equal(parseWindowDays('companies hiring in the last 2 weeks'), 14)
  assert.equal(parseWindowDays('empresas que contrataram nos últimos 3 meses'), 90)
  assert.equal(parseWindowDays('Unternehmen, die in den letzten 30 Tagen expandiert haben'), 30)
  assert.equal(parseWindowDays('entreprises qui recrutent dans les 15 derniers jours'), 15)
  assert.equal(parseWindowDays('startups that raised this month'), 30)
  assert.equal(parseWindowDays('roofers in Ohio'), null)
  assert.equal(parseWindowDays('past 900 days'), 365)
})

test('profile keeps a valid window; prompts state it', () => {
  assert.equal(normalizeIcp({ summary: 's', window_days: 90 })!.window_days, 90)
  assert.equal('window_days' in normalizeIcp({ summary: 's', window_days: 0 })!, false)
  assert.equal('window_days' in normalizeIcp({ summary: 's', window_days: '90' })!, false)
  assert.match(recencyAnchor(NOW, 90), /last 90 days: only include signals dated on or after 2026-07-28/)
  assert.match(recencyAnchor(NOW), /on or after 2025-10-26/)
})

test('with an explicit window only a valid in-window date is inside; stale, undated, invalid and future are split out with their own reason', () => {
  const r = splitByWindow([{ event_date: '2026-04-15' }, { event_date: '2026-10-01' }, { event_date: null }, { event_date: '2026-02-30' }, { event_date: '2026-11-15' }], 90, NOW)
  assert.deepEqual(r.inside, [{ event_date: '2026-10-01' }])
  assert.deepEqual(r.outside.map(l => l.event_date), ['2026-04-15', null, '2026-02-30', '2026-11-15'])
  assert.deepEqual(r.outsideReasons, ['outside_window', 'outside_window_undated', 'event_date_bad_date', 'event_date_future_date'])
  assert.equal(splitByWindow([{ event_date: null }], null, NOW).inside.length, 1, 'no window: undated leads are unchanged')
  assert.equal(splitByWindow([{ event_date: '2020-01-01' }], null, NOW).outside.length, 0)
})

test('#198 end to end: window stored on the profile; the April lead lands in review as outside_window, the recent one stays', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Independent NYC dental practices that recently expanded or are hiring front desk staff', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['new location'], exclude: ['chains'] }
  const id = createQueryJob(db, 'A', { query: Q198, icp: JSON.stringify(icp) } as never)
  const lead = (company: string, date: string, quote: string) => ({ name: '', company, contact: null, signal: 'Opened a new practice', source_url: `https://news.example/${company.replace(/\s/g, '')}`, excerpt: quote, event_date: date, score: 85 })
  const OLD = 'Smile Avenue Dental opened a new practice in Sunnyside in April 2026'
  const NEW = 'Bright Teeth Studio opened its second Brooklyn location this month'
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: JSON.stringify([lead('Smile Avenue Dental', '2026-04-15', OLD), lead('Bright Teeth Studio', '2026-10-10', NEW)]), citedUrls: ['https://news.example/SmileAvenueDental', 'https://news.example/BrightTeethStudio'] }) },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async (url: string) => ({ text: `News. ${url.includes('Smile') ? OLD : NEW}. More.`, title: url.includes('Smile') ? 'Smile Avenue Dental' : 'Bright Teeth Studio', retrievedAt: 1 })
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: page, judge: null, score: false, ground: false, now: NOW }), 'done')
  assert.equal(JSON.parse(getJob(db, 'A', id)!.icp!).window_days, 90)
  const leads = listLeads(db, 'A', id, 200, true) as { company: string; review_reason: string | null }[]
  assert.deepEqual(leads.map(l => [l.company, l.review_reason]).sort(), [['Bright Teeth Studio', null], ['Smile Avenue Dental', 'outside_window']])
})

test('window counts end to end: an undated lead is review, not verified; funnel total is preserved and nothing is dropped', async () => {
  const master = randomBytes(32)
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = { summary: 'Independent NYC dental practices that recently expanded', who: ['Practice owner'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['new location'], exclude: [] }
  const id = createQueryJob(db, 'A', { query: Q198, icp: JSON.stringify(icp) } as never)
  const Q = (c: string) => `${c} opened a new practice in Brooklyn`
  const lead = (company: string, date: string | null) => ({ name: '', company, contact: null, signal: 'Opened a new practice', source_url: `https://news.example/${company.replace(/\s/g, '')}`, excerpt: Q(company), event_date: date, score: 85 })
  const names = ['Smile Avenue Dental', 'Bright Teeth Studio', 'Undated Dental']
  const prov: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: JSON.stringify([lead(names[0], '2026-04-15'), lead(names[1], '2026-10-10'), lead(names[2], null)]), citedUrls: names.map(n => `https://news.example/${n.replace(/\s/g, '')}`) }) },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async (url: string) => { const n = names.find(x => url.includes(x.replace(/\s/g, '')))!; return { text: `News. ${Q(n)}. More.`, title: n, retrievedAt: 1 } }
  assert.equal(await runJob(db, claimKeyedJob(db, id)!, { providers: prov, master, fetchPage: page, judge: null, score: false, ground: false, now: NOW }), 'done')
  const leads = listLeads(db, 'A', id, 200, true) as { company: string; review_reason: string | null }[]
  assert.deepEqual(leads.map(l => [l.company, l.review_reason]).sort(), [['Bright Teeth Studio', null], ['Smile Avenue Dental', 'outside_window'], ['Undated Dental', 'outside_window_undated']])
  const job = db.prepare('SELECT verified, needs_review, dropped FROM scan_jobs WHERE id = ?').get(id) as { verified: number; needs_review: number; dropped: number }
  assert.deepEqual(job, { verified: 1, needs_review: 2, dropped: 0 }, 'the two moved leads are counted under needs_review, not dropped, and verified no longer includes them')
})
