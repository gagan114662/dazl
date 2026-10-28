import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homeSources, homeSteps } from '../lib/home-checklist.ts'
import type { ReadinessInput } from '../lib/readiness.ts'

const job = (id: string, status: string, created_at = 1, over = {}) => ({ id, status, error: null, query: `play ${id}`, csv_domain: null, created_at, lead_count: 3, ...over })
const base: ReadinessInput = { profile: { website: 'https://www.brightsmile.example/', sells: 'dental software', business_name: 'BrightSmile', buyer: { summary: 'Growing dental practices', who: ['Practice owner'] } }, usage: { has_key: true }, outreach: null, jobs: [], totals: { searches: 0, finished: 0 }, sources: { web_index: true, news: true, websites: false }, messages: [], campaigns: [] }
const states = (i: ReadinessInput) => homeSteps(i).map(s => `${s.id}:${s.state}${s.next ? '*' : ''}`)

test('five steps in order; the first to-do is next; each links to where it is done', () => {
  const s = homeSteps(base)
  assert.deepEqual(s.map(x => x.id), ['website', 'brain', 'play', 'approved', 'sent'])
  assert.deepEqual(states(base), ['website:done', 'brain:done', 'play:todo*', 'approved:todo', 'sent:todo'])
  assert.equal(s[0].detail, 'brightsmile.example')
  assert.deepEqual(s.map(x => x.href), ['/app?setup=site', '/app?setup=brain', '/app/leads', '/app/leads', '/app/outreach'])
})

test('a new tenant starts at the website; no buyer means the brain is to do', () => {
  assert.deepEqual(states({ ...base, profile: { sells: '', buyer: null } }), ['website:todo*', 'brain:todo', 'play:todo', 'approved:todo', 'sent:todo'])
})

test('failed reads are "could not check", never done or to-do', () => {
  assert.deepEqual(states({ ...base, profile: null, jobs: null, totals: null, messages: null, campaigns: null }), ['website:unknown', 'brain:unknown', 'play:unknown', 'approved:unknown', 'sent:unknown'])
})

test('play: running links to its live view; finished counts the complete total and links to the latest leads', () => {
  const run = homeSteps({ ...base, jobs: [job('a1', 'running')] })[2]
  assert.deepEqual([run.state, run.detail, run.href], ['todo', 'running now', '/app/leads?job_id=a1'])
  const fin = homeSteps({ ...base, jobs: [job('a1', 'done', 1), job('b2', 'done', 5), job('i', 'done', 9, { csv_domain: 'x' })], totals: { searches: 7, finished: 6 } })[2]
  assert.deepEqual([fin.state, fin.detail, fin.href], ['done', '6 finished; latest: play b2', '/app/leads?job_id=b2'])
})

test('approved and sent need positive evidence; a capped read that finds nothing is unknown', () => {
  const draft = homeSteps({ ...base, jobs: [job('a1', 'done')], messages: [{ status: 'draft' }] })
  assert.deepEqual(draft.slice(3).map(s => `${s.state}:${s.detail}`), ['done:1 draft made from approved leads', 'todo:a draft is waiting: approve its exact text and send'])
  assert.equal(draft[4].next, true)
  const sent = homeSteps({ ...base, messages: [{ status: 'sent' }, { status: 'sent' }] })
  assert.deepEqual([sent[4].state, sent[4].detail], ['done', '2 sent from your Gmail'])
  const capped = homeSteps({ ...base, messages: Array.from({ length: 200 }, () => ({ status: 'skipped' })) })
  assert.deepEqual([capped[3].state, capped[4].state], ['unknown', 'unknown'])
  const viaCampaign = homeSteps({ ...base, messages: null, campaigns: [{ id: 'c', qualification: { rejected: 0 }, outreach: { drafts: 0, approved: 0, sent: 3 } }] })
  assert.deepEqual([viaCampaign[3].state, viaCampaign[4].state, viaCampaign[4].detail], ['done', 'done', '3 sent from your Gmail'])
})

test('sources: those that ran in the last play, else only those configured; never one that cannot run', () => {
  const ran = homeSources(base, [
    { source: 'search:news', state: 'done', status: 'ok', note: null, candidates: 4, accepted: 2, review: 0, rejected: 2 },
    { source: 'search:tinyfish', state: 'done', status: 'empty', note: null, candidates: 0, accepted: 0, review: 0, rejected: 0 },
    { source: 'adapter:reddit', state: 'done', status: 'skipped', note: null, candidates: null, accepted: null, review: null, rejected: null },
    { source: 'adapter:x', state: 'done', status: 'unavailable', note: null, candidates: null, accepted: null, review: null, rejected: null },
    { source: 'adapter:github', state: 'failed', status: 'failed', note: null, candidates: null, accepted: null, review: null, rejected: null },
  ])
  assert.deepEqual(ran, { basis: 'ran', names: ['News articles', 'Web search'] })
  assert.deepEqual(homeSources(base, null), { basis: 'ready', names: ['Web research with your AI key', 'Web search index', 'News articles'] }, 'company websites are switched off here, so not named')
  assert.deepEqual(homeSources({ ...base, usage: { has_key: false } }, null), { basis: 'ready', names: [] }, 'no key: no scan can start, so nothing is called ready')
  assert.equal(homeSources({ ...base, sources: null }, null), null)
})
