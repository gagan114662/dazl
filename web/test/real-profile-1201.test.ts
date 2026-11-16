// #1201 (Refs #1095), review at 9c9fb53 (Ziggy): the UNEDITED five-signal profile of staging job 64a0f578 through the real runner, on two REAL
// Greenhouse boards. On staging that profile's model signal "Sales team expansion from zero" made the sales-hiring gate demand an event beyond
// hiring, so every board posting was held no_event_evidence (0 leads with the signal, 2 without it). Here nothing in the profile is removed.
// REAL, verbatim: the profile and request of job 64a0f578 (staging scan_jobs.icp); the NinjaOne board as its public API returned it on 2026-11-13
// (test/fixtures/1095-ninjaone-greenhouse.json) and the AlertMedia board as it returned it on 2026-11-15 (test/fixtures/1201-alertmedia-greenhouse.json).
// Only the dates are moved, by the days since each fixture was read, so the 30-day window reads the same on any day the test runs.
// SYNTHETIC: the model's replies, and the two aggregator search hits that name the companies (the aggregator pages are unreadable, as in the live run).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runFixture, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { atsPostingRef, atsRecord, atsPageText } from '../lib/sources/ats-posting.ts'
import { htmlToText, decode } from '../lib/scan/fetch-page.ts'
import { ResearchRationale } from '../app/app/leads/research-rationale.ts'

const REQUEST = 'Austin B2B SaaS companies hiring their first account executive in the last 30 days'
const REAL_STAGING_ICP = JSON.parse('{"summary":"B2B SaaS companies in Austin that have hired their first account executive in the last 30 days.","who":["Founder","CEO","VP Sales","Head of Sales","Chief Revenue Officer","VP Revenue"],"industries":["B2B SaaS","Enterprise Software","Cloud Software","Business Software"],"sizes":["1-10 employees","11-50 employees"],"where":["Austin"],"signals":["Hired first account executive in last 30 days","First sales hire","New account executive job posting filled","Sales team expansion from zero","First AE hire"],"exclude":["B2C companies","Non-SaaS companies","Companies with existing account executives before 30 days ago"],"country":"US","language":"en","window_days":30}')
const QUERIES = ['(site:boards.greenhouse.io OR site:job-boards.greenhouse.io) "first account executive" Austin, TX', 'Austin B2B SaaS first account executive hiring Austin, TX', 'Austin software company account executive job posting careers Austin, TX']
type GhJob = { id: number; title: string; first_published: string; updated_at: string; location: { name: string }; content?: string }
type Board = { list: { jobs: GhJob[] }; postings: Record<string, GhJob> }
const BOARDS: Record<string, { name: string; real: Board; read: number; austinAe: number[]; hit: string }> = {
  ninjaone: { name: 'NinjaOne', real: JSON.parse(readFileSync(new URL('./fixtures/1095-ninjaone-greenhouse.json', import.meta.url), 'utf8')), read: Date.UTC(2026, 10, 13), austinAe: [4472362009, 4469783009, 4470849009], hit: 'https://www.thesaasjobs.com/jobs/767593187-account-executive-mid-market-midwest' },
  alertmedia: { name: 'AlertMedia', real: JSON.parse(readFileSync(new URL('./fixtures/1201-alertmedia-greenhouse.json', import.meta.url), 'utf8')), read: Date.UTC(2026, 10, 15), austinAe: [8936418002, 8933316002], hit: 'https://www.thesaasjobs.com/jobs/800000001-account-executive-alertmedia' },
}
const moved = (org: string, iso: string) => new Date(Date.parse(iso) + (Math.floor(Date.now() / 86_400_000) * 86_400_000 - BOARDS[org].read)).toISOString()
const live = <T extends GhJob>(org: string, j: T): T => ({ ...j, first_published: moved(org, j.first_published), updated_at: moved(org, j.updated_at) })
const http: SafeGet = async url => {
  if (new URL(url).hostname === 'hn.algolia.com') return null
  const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
  const m = url.match(/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9]+)\/jobs(?:\/(\d+))?$/)
  const b = m && BOARDS[m[1]]
  if (!b) return null
  if (!m![2]) return j({ ...b.real.list, jobs: b.real.list.jobs.map(x => live(m![1], x)) })
  return b.real.postings[m![2]] ? j(live(m![1], b.real.postings[m![2]])) : null
}
const fetchPage = async (u: string) => {
  const ref = atsPostingRef(u), raw = ref && BOARDS[ref.org]?.real.postings[ref.id]
  if (!ref || !raw) return { fail: 'blocked' as const }
  const rec = atsRecord(live(ref.org, raw), ref)
  if (!rec || rec === 'missing') return { fail: 'error' as const }
  const page = atsPageText(rec, rec.html ? htmlToText(decode(rec.description)).text : rec.description)
  return { text: page.text, title: page.title, board: page.board, retrievedAt: Math.floor(Date.now() / 1000), published: rec.posted, postedAt: rec.posted, structured: [] }
}
function fx(): Fixture {
  const fromSearch: Cand[] = Object.values(BOARDS).map(b => ({ company: b.name, signal: 'is hiring an account executive', source_url: b.hit, excerpt: `${b.name} is hiring an Account Executive in Austin, TX.`, event_date: null as never }))
  return {
    request: REQUEST, modelIcp: REAL_STAGING_ICP, modelQueries: QUERIES,
    hits: Object.values(BOARDS).map(b => ({ url: b.hit, title: `Account Executive - ${b.name}`, snippet: `${b.name} is hiring an Account Executive`, date: null as never })),
    tfPages: {}, own: {}, extraction: fromSearch,
    extractionFn: p => {
      const out = [...fromSearch]
      for (const m of p.matchAll(/\{[^{}]*"source":"jobboards"[^{}]*\}/g)) {
        const it = JSON.parse(m[0]) as { url: string; text: string; date?: string }
        const org = atsPostingRef(it.url)?.org
        if (org && BOARDS[org]) out.push({ company: BOARDS[org].name, signal: 'is hiring an account executive in Austin, TX', source_url: it.url, excerpt: it.text, event_date: it.date ?? (null as never) })
      }
      return out
    },
    deps: { sourceHttp: http, fetchPage },
  }
}

test('#1201: the UNEDITED five-signal staging profile gives source-checked NinjaOne AND AlertMedia leads; the card names the expansion signal as matching-only', async () => {
  assert.equal((REAL_STAGING_ICP.signals as string[]).length, 5)
  assert.ok((REAL_STAGING_ICP.signals as string[]).includes('Sales team expansion from zero'), 'the signal that held every lead on staging is present')
  const x = await runFixture(fx())
  const checked = x.leads.filter(l => !l.review_reason)
  for (const [org, b] of Object.entries(BOARDS)) {
    const lead = checked.find(l => b.austinAe.some(id => l.source_url === `https://job-boards.greenhouse.io/${org}/jobs/${id}`))
    assert.ok(lead, `${b.name}: a source-checked lead (no review reason) cites an Austin Account Executive posting: ${JSON.stringify(x.leads.map(l => [l.company, l.source_url, l.review_reason]))}`)
    const id = lead!.source_url.split('/').pop()!
    assert.equal(lead!.event_date, moved(org, b.real.postings[id].first_published).slice(0, 10), `${b.name}: dated by the board's own first-published day`)
    const why = (x.db.prepare('SELECT why FROM leads WHERE source_url = ? AND review_reason IS NULL').get(lead!.source_url) as { why: string }).why
    assert.match(why, /Your profile signal "Sales team expansion from zero" was used for matching only, not required: your request didn't ask for that event\./, `${b.name}: ${why}`)
    // rendered through the card's own component
    const html = renderToStaticMarkup(h(ResearchRationale, { why }))
    assert.ok(html.startsWith('<div class="text-xs text-gray-300 mt-1">Research rationale: '), html)
    assert.ok(html.includes('Your profile signal &quot;Sales team expansion from zero&quot; was used for matching only, not required'), html)
  }
  assert.equal(x.leads.filter(l => l.review_reason === 'no_event_evidence').length, 0, 'no lead is held for an event the user never asked for')
})
