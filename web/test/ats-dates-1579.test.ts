// #1910 DATES: a hiring lead on an ATS must carry the board's own published date, with the URL it came from. The board's
// public API record is the proof page's own data (no third party), so it counts; nothing else may be guessed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { atsDate, atsPosting } from '../lib/discover/ats-dates.ts'

const NOW = new Date('2026-11-26T12:00:00Z')
type Reply = { status?: number; body: unknown } | 'throw'
const stub = (byUrl: Record<string, Reply>, seen: string[] = []) => {
  const f = (async (u: URL | string) => {
    const key = String(u); seen.push(key)
    const r = byUrl[key]
    if (r === undefined || r === 'throw') throw new Error(`no stub for ${key}`)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body, text: async () => JSON.stringify(r.body) }
  }) as unknown as typeof fetch
  return { f, seen }
}

test('DATES the board is recognised from the posting URL, for every platform we cover', () => {
  const cases: [string, string][] = [
    ['https://boards.greenhouse.io/brightloop/jobs/4567890', 'greenhouse'],
    ['https://job-boards.greenhouse.io/brightloop/jobs/4567890', 'greenhouse'],
    ['https://jobs.lever.co/brightloop/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab', 'lever'],
    ['https://jobs.eu.lever.co/brightloop/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab', 'lever'],
    ['https://apply.workable.com/brightloop/j/1A2B3C4D5E/', 'workable'],
    ['https://brightloop.workable.com/j/1A2B3C4D5E', 'workable'],
    ['https://jobs.ashbyhq.com/brightloop/0a1b2c3d-4e5f-6789-abcd-ef0123456789', 'ashby'],
    ['https://brightloop.bamboohr.com/careers/123', 'bamboohr'],
  ]
  for (const [url, platform] of cases) assert.equal(atsPosting(url)?.platform, platform, url)
  assert.equal(atsPosting('https://example.com/careers/123'), null, 'an ordinary page is not an ATS posting')
})

test('DATES Greenhouse: first_published, and nothing when the board prints only an edit date', async () => {
  const u = 'https://boards.greenhouse.io/brightloop/jobs/4567890'
  const api = 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/4567890'
  const first = await atsDate(u, stub({ [api]: { body: { id: 4567890, first_published: '2026-11-18T09:30:00-05:00', updated_at: '2026-11-24T10:00:00-05:00' } } }).f, NOW)
  assert.deepEqual(first, { date: '2026-11-18', sourceUrl: api, platform: 'greenhouse' })
  // Ziggy's review: an edit date is not a posting date, so updated_at alone gives no date at all.
  const edited = await atsDate(u, stub({ [api]: { body: { id: 4567890, first_published: null, updated_at: '2026-11-24T10:00:00-05:00' } } }).f, NOW)
  assert.equal(edited, null, 'a record with only updated_at gives no date')
})

test('DATES Lever: createdAt is epoch milliseconds, and the EU board uses the EU API', async () => {
  const u = 'https://jobs.eu.lever.co/brightloop/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab'
  const api = 'https://api.eu.lever.co/v0/postings/brightloop/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab'
  const d = await atsDate(u, stub({ [api]: { body: { createdAt: Date.parse('2026-11-20T08:00:00Z') } } }).f, NOW)
  assert.equal(d?.date, '2026-11-20')
  assert.equal(d?.sourceUrl, api)
})

test('DATES Workable and BambooHR read their published fields', async () => {
  const wu = 'https://apply.workable.com/brightloop/j/1A2B3C4D5E/'
  const wapi = 'https://apply.workable.com/api/v1/accounts/brightloop/jobs/1A2B3C4D5E'
  assert.equal((await atsDate(wu, stub({ [wapi]: { body: { published_on: '2026-11-19', created_at: '2026-11-17' } } }).f, NOW))?.date, '2026-11-19')
  const bu = 'https://brightloop.bamboohr.com/careers/123'
  const bapi = 'https://brightloop.bamboohr.com/careers/list'
  const d = await atsDate(bu, stub({ [bapi]: { body: { result: [{ id: '123', postedDate: '2026-11-21', jobOpeningName: 'Service Manager' }] } } }).f, NOW)
  assert.deepEqual(d, { date: '2026-11-21', sourceUrl: bapi, platform: 'bamboohr' })
})

test('DATES Ashby: the board listing is searched for the posting id', async () => {
  const u = 'https://jobs.ashbyhq.com/brightloop/0a1b2c3d-4e5f-6789-abcd-ef0123456789'
  const api = 'https://api.ashbyhq.com/posting-api/job-board/brightloop'
  const body = { jobs: [{ id: 'other', publishedAt: '2026-01-01' }, { id: '0a1b2c3d-4e5f-6789-abcd-ef0123456789', publishedAt: '2026-11-22T00:00:00.000Z' }] }
  assert.equal((await atsDate(u, stub({ [api]: { body } }).f, NOW))?.date, '2026-11-22')
})

test('DATES nothing is invented: missing, unreadable, future and stale dates all give nothing', async () => {
  const u = 'https://boards.greenhouse.io/brightloop/jobs/4567890'
  const api = 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/4567890'
  assert.equal(await atsDate(u, stub({ [api]: { body: { id: 4567890 } } }).f, NOW), null, 'no date field')
  assert.equal(await atsDate(u, stub({ [api]: { status: 404, body: {} } }).f, NOW), null, 'board says gone')
  assert.equal(await atsDate(u, stub({ [api]: { body: { first_published: 'last Tuesday' } } }).f, NOW), null, 'not a date')
  assert.equal(await atsDate(u, stub({ [api]: 'throw' }).f, NOW), null, 'network failure')
  assert.equal(await atsDate(u, stub({ [api]: { body: { first_published: '2026-12-20' } } }).f, NOW), null, 'a date after today')
  assert.equal(await atsDate(u, stub({ [api]: { body: { first_published: '2019-01-01' } } }).f, NOW), null, 'older than the window')
  assert.equal(await atsDate('https://example.com/careers', stub({}).f, NOW), null, 'not an ATS page')
})

test('DATES the day is always YYYY-MM-DD whatever the API prints', async () => {
  const u = 'https://boards.greenhouse.io/brightloop/jobs/4567890'
  const api = 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/4567890'
  for (const raw of ['2026-11-18', '2026-11-18T23:30:00-08:00', '2026-11-18T00:00:00Z', 'November 18, 2026'])
    assert.match((await atsDate(u, stub({ [api]: { body: { first_published: raw } } }).f, NOW))?.date ?? '', /^2026-11-1[89]$/, raw)
})
