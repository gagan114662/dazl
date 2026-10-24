// Lever public postings JSON, fixture only (stub http, no live endpoint). The shape was observed once on the public
// demo board (createdAt epoch milliseconds, hostedUrl, text, categories.location, descriptionPlain); not product yield.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectEvidence } from '../lib/sources/index.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const ms = (n: number) => Date.now() - n * 86_400_000
const BODY = 'We need a payroll specialist to run biweekly payroll for our Columbus team.'
const P = (o: Record<string, unknown>) => ({ text: 'Payroll Specialist', hostedUrl: 'https://jobs.lever.co/acme/1', createdAt: ms(9), categories: { location: 'Columbus, OH', allLocations: ['Columbus, OH'] }, descriptionPlain: `${BODY}\nMore text here that is long enough to count as a paragraph of its own.`, ...o })
const LIST = [
  P({}),
  P({ hostedUrl: 'https://jobs.lever.co/acme/2', categories: { location: 'Austin, TX' } }),
  P({ hostedUrl: 'https://jobs.lever.co/acme/3', createdAt: undefined }),
  P({ hostedUrl: 'https://jobs.lever.co/acme/4', createdAt: ms(300) }),
  P({ hostedUrl: 'https://jobs.lever.co/acme/5', text: 'Software Engineer' }),
  P({ hostedUrl: 'https://jobs.lever.co/acme/6', createdAt: '2026-01-01' }),
  P({ hostedUrl: 'http://jobs.lever.co/acme/7' }),
]
const stub = () => { const seen: string[] = []; const http: SafeGet = async url => { if (new URL(url).hostname === 'hn.algolia.com') return null; seen.push(url); return url === 'https://api.lever.co/v0/postings/acme?mode=json' ? { status: 200, body: JSON.stringify(LIST) } : null }; return { http, seen } }
const sel = { adapters: ['jobboards'], feeds: ['https://jobs.lever.co/acme'], pages: [] }

test('Lever: state, role and window filters; the date is createdAt (epoch ms); no createdAt, a string date, a stale date and a non-https url are dropped', async () => {
  const { http, seen } = stub()
  const ev = await collectEvidence(sel, 'ohio hiring payroll', http, 5000)
  assert.deepEqual(ev.map(e => e.url), ['https://jobs.lever.co/acme/1'])
  assert.equal(ev[0].date, new Date(ms(9)).toISOString().slice(0, 10)); assert.equal(ev[0].quote, BODY); assert.equal(ev[0].source, 'jobboards')
  assert.deepEqual(seen, ['https://api.lever.co/v0/postings/acme?mode=json'], 'exactly one request to the documented host')
})
