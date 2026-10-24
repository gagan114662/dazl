import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { readPage, hitWindows, leadSignals, TASK_TERMS, STACK_NAMES } from '../lib/scan/page-signals.ts'

const q = (text: string) => readPage(text).passages
test('every shown passage is a verbatim slice of the page and carries no verdict, count score or kind label', () => {
  const page = 'About the role. You will own outbound prospecting for our mid-market segment. We use Salesforce and Outreach.io today. Experience with Salesforce required.'
  const r = readPage(page)
  for (const p of r.passages) assert.ok(page.includes(p.quote), p.quote)
  assert.equal(r.passages.length, 3)
  assert.deepEqual(Object.keys(r).sort(), ['chars_read', 'passages', 'passages_total'])
  assert.deepEqual(Object.keys(r.passages[0]).sort(), ['phrases', 'quote', 'terms'])
})
test('negation, customer stories and vendor pitch are flagged as literal phrases, never turned into a claim about the company', () => {
  const neg = q('We are not evaluating any new cold email tools this year.')[0]
  assert.equal(neg.phrases.negation, 'not')
  assert.equal(neg.phrases.evaluation, 'evaluating')
  const no = q('You will not do outbound prospecting in this role.')[0]
  assert.equal(no.phrases.negation, 'not')
  assert.equal(no.phrases.duty, 'You will')
  const cust = q('Our customers are evaluating cold email tools across their teams.')[0]
  assert.equal(cust.phrases.self_description, 'Our customers')
  const pitch = q('Our platform helps sales teams run outbound prospecting.')[0]
  assert.ok(pitch.phrases.self_description)
})
test('a passage with a pricing word is still shown (no swallowing) and keeps its evaluation word', () => {
  const p = q('We are replacing our current pricing intelligence tool and want better cold email prospecting.')[0]
  assert.ok(p)
  assert.equal(p.phrases.evaluation, 'replacing')
  assert.equal(p.phrases.self_description, 'pricing')
})
test('a preferred-stack duty sentence keeps both its duty and requirement phrases, not one label', () => {
  const p = q('You will run outbound prospecting in Salesforce. Preferred: 2 years of Salesforce.')
  assert.ok(p.some(x => x.phrases.duty) && p.some(x => x.phrases.requirement))
})
test('adjacent hits merge into one passage that lists every term found, so none is dropped', () => {
  const w = hitWindows('You will do outbound and outbound prospecting with Salesforce daily.', [...TASK_TERMS, ...STACK_NAMES])
  assert.equal(w.length, 1)
  assert.deepEqual([...w[0].terms].sort(), ['outbound', 'prospecting', 'salesforce'])
})
test('line breaks bound a passage exactly: no neighbouring line leaks in and no character is lost', () => {
  const page = 'Header line\nExecute outbound prospecting daily\nNext line about benefits'
  const w = hitWindows(page, ['outbound'])
  assert.equal(w[0].quote, 'Execute outbound prospecting daily')
})
test('no match is an empty result; a bare "community outreach" and substrings are not hits', () => {
  assert.equal(readPage('Our community outreach program funds local schools. We run outbounds of cargo ships.').passages_total, 0)
  assert.equal(hitWindows('We run outbounds of cargo.', ['outbound']).length, 0)
  assert.equal(hitWindows('Mention of gong.io here.', ['gong.io']).length, 1)
})
test('glued text with no full stops still gives a bounded verbatim passage; output is capped', () => {
  const glued = 'Responsibilities ' + 'word '.repeat(200) + 'Execute daily outbound prospecting against target lists ' + 'word '.repeat(200)
  const r = readPage(glued)
  assert.equal(r.passages.length, 1)
  assert.ok(r.passages[0].quote.length <= 420 && glued.includes(r.passages[0].quote))
  const dense = Array.from({ length: 40 }, (_, i) => `Item ${i}: you will run outbound prospecting for region ${i}.\n${'filler '.repeat(60)}`).join('\n')
  const d = readPage(dense)
  assert.equal(d.passages.length, 12)
  assert.equal(d.passages_total, 40)
})
test('the actual word and tool lists are exported for the UI to show', () => {
  assert.ok(TASK_TERMS.includes('outbound') && STACK_NAMES.includes('salesforce'))
})

function setup() {
  const db = new Database(':memory:'); migrateScan(db)
  const mk = (user: string, id: string, domain: string | null, company = 'Acme') => {
    const job = createQueryJob(db, user, { query: 'q' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
    db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,company_domain) VALUES (?,?,?,?,?,?)").run(id, job, company, 'Posted a role', 'https://weworkremotely.com/remote-jobs/acme-sdr', domain)
  }
  mk('u1', 'a'.repeat(24), 'acme.example'); mk('u1', 'b'.repeat(24), null); mk('u2', 'c'.repeat(24), 'other.example')
  return db
}
const fetcher = async (url: string) => url.includes('acme.example') ? { fail: 'blocked' as const } : { text: 'Acme: you will run outbound prospecting for the team.', title: 't', retrievedAt: 1 }
test('lead reading: own tenant only, posting must name the company, failed pages reported, no model flag', async () => {
  const db = setup()
  assert.equal(await leadSignals(db, 'u2', 'a'.repeat(24), fetcher), null)
  const s = await leadSignals(db, 'u1', 'a'.repeat(24), fetcher)
  assert.equal(s?.model_call, false)
  assert.match(s?.applies_to ?? '', /outbound sales prospecting/)
  assert.deepEqual(s?.pages.map(p => [p.role, p.status]), [['posting', 'read'], ['company_home', 'failed']])
  assert.equal(s?.pages[0].reading?.passages[0].terms[0], 'outbound')
  const other = await leadSignals(db, 'u1', 'b'.repeat(24), async () => ({ text: 'A different company runs outbound prospecting.', title: 't', retrievedAt: 1 }))
  assert.deepEqual(other?.pages.map(p => [p.role, p.status]), [['posting', 'not_used']])
})
