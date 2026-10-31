// #349 a play whose offer is unresolved is not scored. Through the real worker path: claimKeyedJob + runJob on a synthetic
// SQLite database, with a recording fake provider (research names one candidate, the claim check supports it) and one
// synthetic evidence page. The contested play makes no grading or buyer-fit model call and holds its lead at fit 0 with
// the reason named, so it cannot be drafted; the same request with its offer chosen is graded with that offer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { OFFER_UNRESOLVED_WHY } from '../lib/scan/score.ts'
import { createDraft, saveSettings } from '../lib/outreach/service.ts'
import type { Provider } from '../lib/llm/provider.ts'

const DENTAL = 'We sell appointment booking and reminder software to independent dental practices in New York City.'
const CRM = 'CRM setup and outbound consulting'
const QUERY = `Find London SaaS startups hiring their first sales rep. We sell ${CRM}.`
const URL_ = 'https://news.example/synthetic-hiring'
const DAY = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
const PAGE = { text: 'Synthetic SaaS Ltd is hiring its first account executive in London. The London-based SaaS startup is building its first sales team and is hiring its first account executive. Contact hello@syntheticsaas.example.', title: 'Synthetic SaaS Ltd careers', retrievedAt: Math.floor(Date.now() / 1000), published: DAY }

function fake() {
  const prompts: string[] = []
  const answer = (p: string) => p.startsWith('You check one claim') ? 'supports'
    : p.startsWith('You are grading sales leads') ? 'LEAD 1 | fit 4 | intent 4 | action 4 | match ?y?y | signals none | why Synthetic SaaS Ltd is hiring its first account executive in London.' : '[]'
  const provider: Provider = {
    async research(_k, prompt) {
      prompts.push(prompt)
      return { text: JSON.stringify([{ name: 'Alex Example', company: 'Synthetic SaaS Ltd', contact: 'hello@syntheticsaas.example', signal: 'Hiring its first account executive in London', source_url: URL_, excerpt: 'Synthetic SaaS Ltd is hiring its first account executive in London.', event_date: DAY, score: 80 }]), citedUrls: [URL_] }
    },
    async complete(_k, prompt) { prompts.push(prompt); return answer(prompt) },
    async completeDetailed(_k, prompt) { prompts.push(prompt); return { text: answer(prompt), model: 'synthetic-model' } },
    configuredModel: () => 'synthetic-model',
  }
  return { prompts, providers: { anthropic: provider, openai: provider } as Record<'anthropic' | 'openai', Provider> }
}

async function run(offer: string | null) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const master = randomBytes(32)
  db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES ('A', 'a@example.test', 'n', 'Synthetic Co', 'x', 'y', ?)").run(DENTAL)
  saveKey(db, 'A', 'anthropic', 'sk-ant-synthetic-AAAAAAAAAAAAAAAAAAAAAAAA', master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  const id = createQueryJob(db, 'A', { query: QUERY, icp: null, seller: `${DENTAL} - https://seller.example`, offer })
  const job = claimKeyedJob(db, id); assert.ok(job)
  const f = fake()
  assert.equal(await runJob(db, job, { providers: f.providers, master, fetchPage: async u => u === URL_ ? PAGE : { fail: 'not_found' as const }, paidFallback: true }), 'done')
  const lead = db.prepare('SELECT id, fit, intent, why FROM leads WHERE scan_job_id = ?').get(id) as { id: string; fit: number | null; intent: number | null; why: string | null }
  return { db, f, lead, id }
}

test('#349 a contested play makes no grading call and holds its leads until the offer is chosen; a chosen play is graded with its offer', async () => {
  const contested = await run(null)
  try {
    assert.ok(contested.lead, 'the candidate was verified and stored')
    assert.equal(contested.f.prompts.filter(p => p.startsWith('You are grading sales leads')).length, 0, 'no grading model call')
    assert.equal(contested.f.prompts.filter(p => /buyer fit|their own website/i.test(p) && p.includes('Seller offer')).length, 0, 'no buyer-fit model call with an offer')
    assert.ok(contested.f.prompts.every(p => !p.includes('appointment booking')), 'no prompt carries the dental offer')
    assert.deepEqual([contested.lead.fit, contested.lead.intent], [0, null]); assert.ok(contested.lead.why?.includes(OFFER_UNRESOLVED_WHY), contested.lead.why ?? '')
    // and it cannot be drafted
    contested.db.prepare('UPDATE leads SET human_confirmed_at = 1, human_confirmed_from = ? WHERE id = ?').run('test_review', contested.lead.id)
    assert.throws(() => createDraft(contested.db, 'A', contested.lead.id, 'Synthetic Co'), /offer_conflict|lead_ungraded/)
  } finally { contested.db.close() }

  const chosen = await run(CRM)
  try {
    const grading = chosen.f.prompts.filter(p => p.startsWith('You are grading sales leads'))
    assert.equal(grading.length, 1, 'graded once')
    assert.match(grading[0], /CRM setup and outbound consulting/); assert.doesNotMatch(grading[0], /appointment booking/)
    assert.ok((chosen.lead.fit ?? 0) > 0 && !chosen.lead.why?.includes(OFFER_UNRESOLVED_WHY), 'graded, not held (later gates may adjust the grade)')
  } finally { chosen.db.close() }
})
