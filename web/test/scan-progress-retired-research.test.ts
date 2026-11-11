// #919: key-based web research is retired (#510, provider.research refuses research_unbounded before any request). The
// live per-source progress (Leads + first run, via status-read-service -> progressOf -> sourceName) must not list it as
// a source this scan could use. Rows with a real answer from before the retirement keep their history. Offline only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { progressOf, isRetiredResearchRow, outcomeInputs } from '../lib/scan/progress.ts'
import { sourceName } from '../lib/source-progress-copy.ts'
import { anthropicProvider, openaiProvider } from '../lib/llm/provider.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'

const RETIRED_LABEL = /Web research with your AI key/
const labels = (rows: Parameters<typeof progressOf>[0], status: string) => progressOf(rows, status).map(p => sourceName(p.source))

test('#919: both real providers still refuse research before any request (the capability the label would promise)', async () => {
  for (const p of [anthropicProvider, openaiProvider]) {
    let calls = 0
    const f = (async () => { calls++; throw new Error('must not be called') }) as unknown as typeof fetch
    await assert.rejects(() => p.research('sk-test', 'find companies', f), (e: unknown) => e instanceof SpendRefused && (e as SpendRefused).reason === 'research_unbounded')
    assert.equal(calls, 0)
  }
})

test('#919: a refused (skipped) retired-research row is not listed as a source, running or finished', () => {
  for (const collector of ['search:anthropic', 'search:openai']) {
    for (const status of ['skipped_hold', 'skipped', 'SKIPPED_hold']) {
      for (const job of ['running', 'pending', 'done', 'failed']) {
        const rows = [{ collector: 'search:tinyfish', status: 'empty', candidate_count: 0 }, { collector, status }]
        assert.deepEqual(labels(rows, job), ['Web search'], `${collector}/${status}/${job}`)
      }
    }
  }
})

test('#919: a retired-research row that is only "started" while the scan runs is not shown as "Reading ..."', () => {
  for (const s of ['started', 'queued', 'pending']) {
    const p = progressOf([{ collector: 'search:anthropic', status: s }, { collector: 'search:news', status: 'started' }], 'running')
    assert.deepEqual(p.map(x => [x.source, x.state]), [['search:news', 'running']])
  }
})

test('#919: history is not rewritten - real answers from before the retirement and a finished unanswered row stay visible', () => {
  const rows = [
    { collector: 'search:anthropic', status: 'ok', candidate_count: 3, verified_count: 1, review_count: 0 },
    { collector: 'search:openai', status: 'error' },
  ]
  const p = progressOf(rows, 'done')
  assert.deepEqual(p.map(x => [x.source, x.status]), [['search:anthropic', 'ok'], ['search:openai', 'failed']])
  // a finished scan whose research row never reported is a failure, shown, never hidden
  assert.deepEqual(progressOf([{ collector: 'search:anthropic', status: 'started' }], 'failed').map(x => x.status), ['failed'])
  // the outcome inputs (failed sources) are computed from the raw rows and are unchanged
  assert.deepEqual(outcomeInputs(null, [{ collector: 'search:anthropic', status: 'skipped_hold' }], 'failed').failed_sources, [])
})

test('#919: only the two retired collectors are filtered - other skipped sources keep their row', () => {
  const rows = [
    { collector: 'adapter:jobboards', status: 'skipped_no_hiring_signal' },
    { collector: 'search:anthropic-extra', status: 'skipped_hold' },
    { collector: 'xsearch:anthropic', status: 'skipped_hold' },
    { collector: 'search:tinyfish', status: 'skipped_hold' },
  ]
  assert.equal(progressOf(rows, 'done').length, 4)
})

test('#919 adversarial: malformed rows fail closed (no throw, no invented retired-research row)', () => {
  const junk = [
    null, undefined, 7, 'search:anthropic', [], { collector: ['search:anthropic'], status: 'skipped_hold' },
    { collector: 'search:anthropic' }, { collector: 'search:anthropic', status: null }, { collector: 'search:anthropic', status: { x: 1 } },
    { collector: 'search:anthropic', status: 'skipped_hold', candidate_count: '3' }, { collector: null, status: 'ok' }, { status: 'ok' },
    { collector: 'search:anthropic\u0000', status: 'skipped_hold' }, { collector: 'x'.repeat(100000), status: 'ok' },
  ] as unknown as Parameters<typeof progressOf>[0]
  for (const job of ['running', 'done', '', 'bogus']) {
    const p = progressOf(junk, job)
    assert.ok(p.every(x => !(x.source === 'search:anthropic' && x.status === 'skipped')), job)
  }
  assert.deepEqual(progressOf(null as never, 'done'), [])
  assert.deepEqual(progressOf({} as never, 'done'), [])
  assert.equal(isRetiredResearchRow({ collector: 'search:openai', status: 'skipped_hold' }, false), true)
  assert.equal(isRetiredResearchRow({ collector: 'search:openai', status: 'ok' }, false), false)
  // a status that is not a string is not "skipped": the row stays (status rendered from String(status), as before)
  assert.equal(isRetiredResearchRow({ collector: 'search:anthropic', status: 42 }, false), false)
})

test('#919: through the real runJob - a BYOK scan whose sources found nothing records the refused research row, and progress does not list it', async () => {
  const QUOTE = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
  const page = { title: 'Brightloop', text: `On ${daysAgo(12)}, ${QUOTE}.` }
  const f: Fixture = {
    request: 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.',
    modelIcp: { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 },
    modelQueries: ['London SaaS startup seed round'], hits: [], tfPages: {}, own: { x: page }, extraction: [], researchRetired: true,
  }
  const r = await runFixture(f)
  const jobId = (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const job = r.db.prepare('SELECT status FROM scan_jobs').get() as { status: string }
  const rows = sourceRuns(r.db, 'A', jobId) as Record<string, unknown>[]
  const research = rows.filter(x => typeof x.collector === 'string' && /^search:(anthropic|openai)$/.test(x.collector))
  const shown = labels(rows as never, job.status)
  // Pin the shape: if the runner records a research row at all it is a refusal before any request (never ok/error).
  for (const x of research) assert.match(String(x.status), /^skipped/, JSON.stringify(rows))
  assert.ok(shown.every(l => !RETIRED_LABEL.test(l)), `progress lists the retired source: ${JSON.stringify(shown)} from ${JSON.stringify(rows)}`)
})
