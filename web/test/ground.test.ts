import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { cachedFetcher, groundPrompt, groundLeads, runJob, claimKeyedJob } from '../lib/scan/runner.ts'
import { migrateScan, createJob, listLeads } from '../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'

const QUOTE = 'Acme Robotics raised a 5 million seed round and is hiring its first sales team in London'
const PAD = ' London startup scene continues to grow with new funding announcements this autumn.'.repeat(3)
const page = (text: string) => ({ text: text + PAD, title: 'Acme Robotics', retrievedAt: 1_800_000_000 })

test('cachedFetcher fetches each URL once', async () => {
  let n = 0
  const f = cachedFetcher(async (u: string) => { n++; return page(`text for ${u}`) })
  await f('https://a.com/x'); await f('https://a.com/x'); await f('https://a.com/y')
  assert.equal(n, 2)
})

test('groundPrompt carries the fetched page text and the verbatim-copy rule', () => {
  const p = groundPrompt('seed startups hiring sales', [{ url: 'https://a.com/x', text: QUOTE }])
  assert.ok(p.includes(QUOTE))
  assert.ok(p.includes('VERBATIM'))
  assert.ok(p.includes('https://a.com/x'))
})

test('groundLeads returns candidates whose quotes come from fetched text; null when nothing fetches', async () => {
  const provider = { complete: async (_k: string, _p: string) => JSON.stringify([{ name: '', company: 'Acme Robotics', contact: null, signal: 'raised seed and hiring sales', source_url: 'https://a.com/x', excerpt: QUOTE, event_date: '2026-10-01', score: 80 }]) }
  const cands = [{ name: '', company: 'Acme Robotics', contact: null, signal: 's', source_url: 'https://a.com/x', score: 70, excerpt: 'paraphrased from memory', event_date: null }]
  const out = await groundLeads(provider as never, 'k', 'q', cands, async () => page(`News. ${QUOTE}. More.`), undefined)
  assert.equal(out![0].excerpt, QUOTE)
  const none = await groundLeads(provider as never, 'k', 'q', cands, async () => { throw new Error('nope') }, undefined)
  assert.equal(none, null)
})

test('end to end: memory-quoted candidates are rewritten from real pages and verify', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  const master = randomBytes(32)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-' + 'A'.repeat(40), master)
  const id = createJob(db, 'A', { business_name: 'SalesTools', industry: 'saas', location: 'London' })
  // research() answers from "memory": right URL, fabricated quote. complete() (the grounding pass)
  // answers from the real page text.
  const memory = JSON.stringify([{ name: '', company: 'Acme Robotics', contact: null, signal: 'raised seed and hiring sales', source_url: 'https://acmerobotics.example/blog/seed', excerpt: 'Acme Robotics just got funded and wants salespeople', event_date: '2026-10-01', score: 80 }])
  const grounded = JSON.stringify([{ name: '', company: 'Acme Robotics', contact: null, signal: 'raised seed and hiring sales', source_url: 'https://acmerobotics.example/blog/seed', excerpt: QUOTE, event_date: '2026-10-01', score: 80 }])
  let completeCalls = 0
  const providers = {
    anthropic: { research: async () => ({ text: memory, citedUrls: ['https://acmerobotics.example/blog/seed'] }), complete: async () => { completeCalls++; return grounded } },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }) },
  }
  let fetches = 0
  const fetchPage = async () => { fetches++; return page(`October 2026 news. ${QUOTE}.`) }
  const out = await runJob(db, claimKeyedJob(db)!, { providers, master, now: new Date('2026-10-20'), fetchPage, judge: null, score: false })
  assert.equal(out, 'done')
  assert.equal(completeCalls, 1)
  const rows = listLeads(db, 'A', id) as { evidence_excerpt: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].evidence_excerpt, QUOTE)
  assert.equal(fetches, 1) // grounding and the verifier shared one fetch
})

test('grounding off or producing nothing keeps the original candidates', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  const master = randomBytes(32)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-' + 'A'.repeat(40), master)
  const id = createJob(db, 'A', { business_name: 'SalesTools', industry: 'saas', location: 'London' })
  const good = JSON.stringify([{ name: '', company: 'Acme Robotics', contact: null, signal: 'raised seed', source_url: 'https://acmerobotics.example/blog/seed', excerpt: QUOTE, event_date: '2026-10-01', score: 80 }])
  const providers = { anthropic: { research: async () => ({ text: good, citedUrls: ['https://acmerobotics.example/blog/seed'] }), complete: async () => 'garbage' }, openai: { research: async () => ({ text: '[]', citedUrls: [] }) } }
  const out = await runJob(db, claimKeyedJob(db)!, { providers, master, now: new Date('2026-10-20'), fetchPage: async () => page(QUOTE), judge: null, score: false })
  assert.equal(out, 'done')
  assert.equal((listLeads(db, 'A', id) as unknown[]).length, 1)
})
