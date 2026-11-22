import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { applyBuyerFitGate, parseBuyerFit, FIT_CAP } from '../lib/scan/buyer-fit.ts'
import { ProviderError } from '../lib/llm/provider.ts'

// Refs #1122 (run e1334435): Simple AI and Nebulock were capped to fit 3 by "the fit check returned no answer" while size matched.
// A check that gives no answer must not quietly cap: lenient reading of the answer lines, one rerun of the unanswered companies, and a
// counted, named outcome. A real "no" / "unknown" still caps, and an answer that never comes still fails closed - but is reported.
const HOME = 'Simple AI builds voice agents that answer every customer call for contact centers and sales teams across North America. '.repeat(3)
function setup() {
  const db = new Database(':memory:'); migrateScan(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status) VALUES ('j','u','b','i','l','q','running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, fit, why, company_domain, dedup_key) VALUES ('a','j','','Simple AI','Simple AI is hiring an SDR','https://usesimple.ai/careers',80,5,'graded','usesimple.ai','a')").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j'").run()
  return db
}
const fit = (db: Database.Database) => (db.prepare("SELECT fit FROM leads WHERE id='a'").get() as { fit: number }).fit
const page = async () => ({ text: HOME, title: 'Simple AI', retrievedAt: 1 })
const seq = (...replies: (string | Error)[]): Provider & { calls: number } => {
  const p = { calls: 0, research: async () => ({ text: '', citedUrls: [] }), complete: async () => { const r = replies[Math.min(p.calls++, replies.length - 1)]; if (r instanceof Error) throw r; return r } }
  return p
}
const YES = 'builds voice agents that answer every customer call for contact centers'

test('answer lines in common model formats are read (bold, colons, dashes, quoted)', () => {
  for (const line of [`**COMPANY 1** | fit: yes | quote: "${YES}"`, `Company 1 - fit: YES - quote: ${YES}`, `COMPANY 1: | fit yes | quote ${YES}`, `- COMPANY 1 | **fit yes** | quote \`${YES}\``])
    assert.deepEqual(parseBuyerFit(line).get(1), { fit: 'yes', quote: YES }, line)
})
test('no answer: the unanswered companies are asked once more; an answer then counts', async () => {
  for (const first of [new ProviderError('retry', 'bad output', 'none'), 'I cannot determine this.']) {
    const db = setup(), p = seq(first, `COMPANY 1 | fit yes | quote ${YES}`)
    const r = await applyBuyerFitGate(db, 'j', p, 'k', 'icp', { fetchPage: page })
    assert.equal(p.calls, 2); assert.equal(fit(db), 5); assert.equal(r.confirmed, 1); assert.equal(r.noAnswer, 0)
  }
})
test('still no answer after the rerun: fail closed, but counted and named with its cause', async () => {
  const db = setup(), p = seq('Sorry, no idea.')
  const r = await applyBuyerFitGate(db, 'j', p, 'k', 'icp', { fetchPage: page })
  assert.equal(p.calls, 2); assert.equal(fit(db), FIT_CAP); assert.equal(r.noAnswer, 1); assert.match(r.noAnswerCause ?? '', /unreadable reply: Sorry/)
  // a real "no" still caps, with no rerun
  const db2 = setup(), p2 = seq('COMPANY 1 | fit no | quote none')
  await applyBuyerFitGate(db2, 'j', p2, 'k', 'icp', { fetchPage: page })
  assert.equal(p2.calls, 1); assert.equal(fit(db2), FIT_CAP)
})

test('Qodo #1541: a failed request that may have been billed (uncertain / rejected / unclassified) is never rerun, and the why says so', async () => {
  for (const err of [new ProviderError('retry', 'timeout', 'uncertain'), new ProviderError('retry', '429', 'rejected', 429), new Error('socket hang up')]) {
    const db = setup(), p = seq(err, `COMPANY 1 | fit yes | quote ${YES}`)
    const r = await applyBuyerFitGate(db, 'j', p, 'k', 'icp', { fetchPage: page })
    assert.equal(p.calls, 1, err.message); assert.equal(fit(db), FIT_CAP); assert.equal(r.noAnswer, 1)
    const why = (db.prepare("SELECT why FROM leads WHERE id='a'").get() as { why: string }).why
    assert.match(why, /not rerun/); assert.doesNotMatch(why, /after a rerun/)
  }
  // nothing outstanding at the vendor (charge 'none'): the ordinary retry applies
  const db = setup(), p = seq(new ProviderError('retry', 'bad output', 'none'), `COMPANY 1 | fit yes | quote ${YES}`)
  await applyBuyerFitGate(db, 'j', p, 'k', 'icp', { fetchPage: page })
  assert.equal(p.calls, 2); assert.equal(fit(db), 5)
})
