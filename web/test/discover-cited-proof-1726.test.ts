import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead, isShown } from '../lib/discover/check.ts'

for (const fixture of [
  {
    language: 'Spanish',
    claim: 'Ampliará el servicio regional',
    unsupported: 'El anuncio menciona el servicio regional. La empresa ampliará el horario habitual.',
    supported: 'El anuncio confirma que ampliará el servicio regional.',
    quote: 'el servicio regional',
  },
  {
    language: 'French',
    claim: 'Agrandira le centre régional',
    unsupported: 'Le rapport présente le centre régional. La société agrandira son parking.',
    supported: 'Le rapport confirme qu’elle agrandira le centre régional.',
    quote: 'le centre régional',
  },
]) {
  test(`#1726 ${fixture.language}: separate cited sentences cannot be pooled into the claimed event`, async () => {
    const company = 'Example Cooperative'
    const [lead] = parseLeads(JSON.stringify({ leads: [{
      company, signal: fixture.claim, evidence_url: 'https://fixture.example/post',
      evidence_quote: fixture.unsupported,
    }] }), 1).leads
    assert.ok(lead)
    const read = async () => new Response(`<h1>${company}</h1><p>${fixture.unsupported}</p>`)
    const checked = await checkLead(lead, [], read)
    assert.equal(checked.quote_on_page, true)
    assert.equal(isShown(checked), false)
    assert.ok(checked.claim_lacks.length > 0)
  })

  test(`#1726 ${fixture.language}: the cited statement can support the claimed event`, async () => {
    const company = 'Example Cooperative'
    const [lead] = parseLeads(JSON.stringify({ leads: [{
      company, signal: fixture.claim, evidence_url: 'https://fixture.example/post',
      evidence_quote: fixture.quote,
    }] }), 1).leads
    assert.ok(lead)
    const read = async () => new Response(`<h1>${company}</h1><p>${fixture.supported}</p>`)
    assert.equal(isShown(await checkLead(lead, [], read)), true)
  })
}


for (const { label, signal, readable } of [
  { label: 'missing words', signal: 'Opened its second factory', readable: true },
  { label: 'long claim', signal: Array.from({ length: 32 }, (_, i) => `requirement${i}`).join(' '), readable: true },
  { label: 'unread proof', signal: 'Opened its second factory', readable: false },
]) test(`#1726 held Discovery evidence: ${label}`, async () => {
  const db = new Database(':memory:')
  try {
    const master = randomBytes(32)
    migrateAllSqlite(db)
    saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
    const jobId = createQueryJob(db, 'T', { query: 'Local businesses opening a second location' })
    const job = claimKeyedJob(db, jobId)
    assert.ok(job)
    const evidenceUrl = 'https://fixture.example/statement'
    const company = 'Example Cooperative'
    const evidence = 'Example Cooperative opened its second office.'
    const [lead] = parseLeads(JSON.stringify({ leads: [{
      company, signal, evidence_url: evidenceUrl, evidence_quote: evidence,
    }] }), 1).leads
    assert.ok(lead)
    let searched = false
    const result = await runJob(db, job, {
      master, discover: true, enrichImpl: null, fetchImpl: async () => new Response(null, { status: 403 }),
      discoverImpl: async () => {
        const leads = searched ? [] : [lead]
        searched = true
        return { leads, seen: [{ url: evidenceUrl, title: company, text: readable ? evidence : null, page_age: null }],
          usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.04 },
          stop: 'end_turn', model: 'claude-opus-5-5', note: null }
      },
    })
    assert.equal(result, 'done')
    const row = db.prepare('SELECT id, review_reason FROM leads WHERE scan_job_id = ?').get(jobId) as { id: string; review_reason: string }
    assert.equal(row.review_reason, 'source_review_required')
    const enrichments = enrichmentsForLeads(db, 'T', [row.id])[row.id] ?? []
    const stored = enrichments.find(entry => entry.kind === 'claim_lacks')
    if (!readable) {
      assert.equal(stored, undefined)
      return
    }
    assert.ok(stored)
    assert.equal(stored.source_url, evidenceUrl)
    if (label === 'long claim') {
      assert.match(stored.value, /^requirement0, requirement1/)
      assert.match(stored.value, /…$/)
      assert.ok(stored.value.length <= 254)
    } else {
      assert.equal(stored.value, 'factory')
    }
  } finally {
    db.close()
  }
})
