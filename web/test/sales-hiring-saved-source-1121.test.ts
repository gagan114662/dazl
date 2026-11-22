// Offline regression using Mercury wording from #1121. Stubbed discovery is not live evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo } from './helpers/acceptance-harness.ts'
import { planObject, PLACE } from './helpers/request-plan-stub.ts'

const request = 'Toronto agencies hiring an SDR'
// #1395 SYNTHETIC request plan for `request`: its one place as written ("Toronto").
const plan = planObject([PLACE.toronto], { buyer_type: 'agencies', signals: [{ kind: 'hiring', text: 'hiring an SDR', negated: false }] })
const posting = 'https://job-boards.greenhouse.io/mercury/jobs/6167220004'
const news = 'https://news.example/mercury'
const quote = 'As a Sales Development Representative at Mercury, you\u0027ll be the first point of contact for founders...'
const funding = 'Mercury raised a seed funding round in Toronto'
const profile = { summary: request, who: ['Founder'], industries: [], sizes: [], where: ['Toronto'], signals: ['hiring SDR'], exclude: [], country: 'CA', language: 'en', window_days: 90 }

async function savedSource(title: string, opts: { day?: string | null; org?: string; unreadable?: boolean; pageOnlyDate?: boolean; employer?: string } = {}) {
  const day = opts.day === undefined ? daysAgo(2) : opts.day
  const postingQuote = opts.pageOnlyDate ? `On ${day}, Mercury hired a Sales Development Representative for its Toronto team.` : quote
  const source = opts.org ? posting.replace('/mercury/', '/othercorp/') : posting
  const x = await runFixture({
    request, modelPlan: plan, modelIcp: profile, modelQueries: ['Toronto agencies hiring SDR'],
    hits: [news, source].map(url => ({ url, title: 'Mercury', snippet: url === news ? funding : postingQuote, date: daysAgo(2) })),
    tfPages: {}, own: {},
    extraction: [
      { company: 'Mercury', signal: 'raised seed funding', source_url: news, score: 99, excerpt: funding, event_date: daysAgo(2) },
      { company: 'Mercury', signal: 'hiring SDR', source_url: source, score: 98, excerpt: postingQuote, event_date: day },
    ],
    deps: { paidFallback: false, fetchPage: async (url: string) => url === source && opts.unreadable ? { fail: 'blocked' } : ({
      title: url === news ? 'Mercury funding' : title,
      text: url === news ? `On ${daysAgo(2)}, ${funding}.` : `${title}. Toronto. ${postingQuote}.`,
      retrievedAt: Math.floor(Date.now() / 1000),
      ...(url === source ? { board: { slug: opts.org ?? 'mercury', company: opts.employer ?? (opts.org ? 'Othercorp' : 'Mercury'), title }, postedAt: opts.pageOnlyDate ? null : day } : {}),
    }) },
  })
  return { ...x, row: x.db.prepare('SELECT id, source_url, evidence_excerpt, review_reason FROM leads WHERE company = ?').get('Mercury') as { id: string; source_url: string; evidence_excerpt: string; review_reason: string | null } }
}

test('#1121 saved-source writer and gate retain verified SDR proof when funding wins company dedup', async () => {
  const x = await savedSource('Sales Development Representative')
  try {
    assert.equal(x.r, 'done')
    assert.ok(x.row, JSON.stringify(x.job))
    assert.equal(x.row.source_url, news, 'actual writer keeps the non-hiring primary source')
    assert.equal(x.row.evidence_excerpt, funding)
    assert.equal(x.row.review_reason, null, JSON.stringify(x.row))
    const proof = x.db.prepare('SELECT source_url, label FROM lead_enrichments WHERE lead_id = ? AND kind = ?').all(x.row.id, 'hiring') as { source_url: string; label: string }[]
    assert.ok(proof.some(p => p.source_url === posting && p.label.includes('Sales Development Representative')), JSON.stringify(proof))
  } finally { x.db.close() }
})

test('#1121 saved-source writer rejects Art Director, SDR manager, internship and talent pool as SDR proof', async () => {
  // Art Director is from the collaborator report; the surrounding fixture is synthetic.
  for (const title of ['Senior Art Director', 'Sales Development Representative (SDR) Manager', 'Sales Development Representative Internship', 'Sales Development Representative Talent Community']) {
    const x = await savedSource(title)
    try {
      assert.ok(x.row, title)
      assert.equal(x.row.review_reason, 'no_sales_hiring_evidence', title)
      assert.equal((x.db.prepare('SELECT COUNT(*) AS n FROM lead_enrichments WHERE lead_id = ? AND kind = ?').get(x.row.id, 'gate_passed') as { n: number }).n, 0, title)
    } finally { x.db.close() }
  }
})


test('#1121 joined posting must be source-checked, own-company, dated within the clock and carry a verified title', async () => {
  for (const [why, title, opts] of [
    ['stale', 'Sales Development Representative', { day: daysAgo(200) }],
    ['undated', 'Sales Development Representative', { day: null }],
    ['future', 'Sales Development Representative', { day: daysAgo(-10) }],
    ['wrong company', 'Sales Development Representative', { org: 'othercorp' }],
    ['unreadable', 'Sales Development Representative', { unreadable: true }],
    ['missing title', '', {}],
  ] as const) {
    const x = await savedSource(title, opts)
    try {
      assert.ok(x.row, why)
      assert.equal(x.row.review_reason, 'no_sales_hiring_evidence', why)
      assert.equal((x.db.prepare('SELECT COUNT(*) AS n FROM lead_enrichments WHERE lead_id = ? AND kind = ?').get(x.row.id, 'gate_passed') as { n: number }).n, 0, why)
    } finally { x.db.close() }
  }
})

test('#1121 alternate posting cannot use a page-only event date as its structured posting date', async () => {
  const x = await savedSource('Sales Development Representative', { pageOnlyDate: true })
  try {
    assert.ok(x.row)
    assert.equal(x.row.source_url, news)
    assert.equal(x.row.review_reason, 'no_sales_hiring_evidence')
    assert.equal((x.db.prepare("SELECT COUNT(*) AS n FROM lead_enrichments WHERE lead_id = ? AND kind = 'hiring'").get(x.row.id) as { n: number }).n, 0)
  } finally { x.db.close() }
})

test('#1121 matching board slug and quote cannot override the posting record’s stated employer', async () => {
  const x = await savedSource('Sales Development Representative', { employer: 'Fictional Birchford Systems' })
  try {
    assert.ok(x.row)
    assert.equal(x.row.source_url, news, 'the genuine primary source remains saved')
    assert.equal(x.row.review_reason, 'no_sales_hiring_evidence')
    const kinds = x.db.prepare("SELECT kind FROM lead_enrichments WHERE lead_id = ? AND kind IN ('hiring', 'gate_passed')").all(x.row.id)
    assert.deepEqual(kinds, [], 'no wrong-employer hiring receipt or pass marker is saved')
  } finally { x.db.close() }
})
