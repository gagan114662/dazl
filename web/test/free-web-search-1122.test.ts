import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sc from '../lib/connectors/sitecrawl.ts'
import * as fsf from '../lib/connectors/free-site-finder.ts'

// #1122 / #1037: the live prod run of 2026-11-16 (prod 10e3dc3e, job 6b7e54aaf53b67fc7e874115, "Small marketing and creative agencies in
// Toronto, Ontario hiring an SDR") kept one lead, War Room, held for review, with no company website and "No buyer named yet". Its source was
// an aggregator posting whose page links no company site, only the employer's Rippling posting. Shapes below are from that real page.
const html = (b: string) => `<html><body>${b}</body></html>`
test('#1122 #1037 the free web search: parses DuckDuckGo HTML results and runs only when Wikidata and OpenStreetMap placed nothing', async () => {
  const ddg = html(`<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwarroominc.com%2F&amp;rut=x">War Room | Programmatic Agency</a>
<a class="result__a" href="https://www.linkedin.com/company/war-room-inc">War Room - LinkedIn</a>`)
  assert.deepEqual(fsf.parseDuckDuckGoHtml(ddg), ['https://warroominc.com/', 'https://www.linkedin.com/company/war-room-inc'])
  const asked: string[] = []
  const fetchImpl = (async (url: string) => { asked.push(new URL(url).hostname); return new URL(url).hostname === 'html.duckduckgo.com' ? new Response(ddg, { status: 200 }) : new Response('x', { status: 500 }) }) as unknown as typeof fetch
  fsf.resetFreeSiteFinderPacing()
  const r = await fsf.freeCompanySitesDetailed('War Room', ['Toronto, Ontario'], { fetchImpl, sleep: async () => {}, now: () => 1e12, webSearch: true })
  assert.equal(r.outcomes.websearch, 'ok')
  assert.deepEqual(r.hits.map(h => h.url), ['https://warroominc.com/', 'https://www.linkedin.com/company/war-room-inc'])
  assert.deepEqual(sc.companyHostsFromSearch('War Room', r.hits, 3, ['Toronto, Ontario']), ['warroominc.com'], 'only a host carrying the name survives')
  const off = await fsf.freeCompanySitesDetailed('War Room', [], { fetchImpl, sleep: async () => {}, now: () => 2e12 })
  assert.equal(off.outcomes.websearch, undefined)
})
