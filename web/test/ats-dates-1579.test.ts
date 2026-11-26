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
// A careers index page on a board links to its postings but prints no dates. The board's own list record carries them.
test('DATES a board index is recognised and its list record names the date', async () => {
  const { atsList, atsListDate } = await import('../lib/discover/ats-dates.ts')
  const cases: [string, string, string, unknown][] = [
    ['workable', 'https://brightloop.workable.com/', 'https://apply.workable.com/brightloop/j/1A2B3C4D5E', { jobs: [{ shortcode: '1A2B3C4D5E', url: 'https://apply.workable.com/brightloop/j/1A2B3C4D5E', published_on: '2026-11-19' }] }],
    ['lever', 'https://jobs.lever.co/brightloop', 'https://jobs.lever.co/brightloop/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab', [{ id: '9f1c2f7a-1b2c-4d5e-8f90-1234567890ab', hostedUrl: 'https://jobs.lever.co/brightloop/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab', createdAt: Date.parse('2026-11-20T08:00:00Z') }]],
    ['ashby', 'https://jobs.ashbyhq.com/brightloop', 'https://jobs.ashbyhq.com/brightloop/0a1b2c3d-4e5f-6789-abcd-ef0123456789', { jobs: [{ id: '0a1b2c3d-4e5f-6789-abcd-ef0123456789', jobUrl: 'https://jobs.ashbyhq.com/brightloop/0a1b2c3d-4e5f-6789-abcd-ef0123456789', publishedAt: '2026-11-22T00:00:00.000Z' }] }],
  ]
  for (const [platform, index, posting, body] of cases) {
    const rec = atsList(index)
    assert.equal(rec?.platform, platform, index)
    const d = await atsListDate(index, posting, stub({ [rec!.apiUrl]: { body } }).f, NOW)
    assert.equal(d?.date, body && platform === 'workable' ? '2026-11-19' : platform === 'lever' ? '2026-11-20' : '2026-11-22', `${platform} list date`)
    assert.equal(d?.sourceUrl, rec!.apiUrl, `${platform} cites the list record`)
  }
})

test('DATES the list fails closed: no entry, no date, two days for one posting, a non-board index, a network error', async () => {
  const { atsListDate } = await import('../lib/discover/ats-dates.ts')
  const index = 'https://brightloop.workable.com/'
  const posting = 'https://apply.workable.com/brightloop/j/1A2B3C4D5E'
  const api = 'https://apply.workable.com/api/v1/accounts/brightloop/jobs?details=true'
  assert.equal(await atsListDate(index, posting, stub({ [api]: { body: { jobs: [{ shortcode: 'OTHER', published_on: '2026-11-19' }] } } }).f, NOW), null, 'no entry for this posting')
  assert.equal(await atsListDate(index, posting, stub({ [api]: { body: { jobs: [{ shortcode: '1A2B3C4D5E' }] } } }).f, NOW), null, 'entry carries no date')
  assert.equal(await atsListDate(index, posting, stub({ [api]: { body: { jobs: [{ shortcode: '1A2B3C4D5E', published_on: '2026-11-19' }, { shortcode: '1A2B3C4D5E', published_on: '2026-11-20' }] } } }).f, NOW), null, 'two days for one posting is not a fact')
  assert.equal(await atsListDate('https://example.com/careers', posting, stub({}).f, NOW), null, 'not a board index')
  assert.equal(await atsListDate(index, posting, stub({ [api]: 'throw' }).f, NOW), null, 'network failure')
})

// Control for the rule above: when one record fails closed, an unrelated posting on another board still gets its own day from the
// same code path, so the null is the record's fault and not the reader refusing everything.
test('DATES control: an unrelated posting still dates itself when another record fails closed', async () => {
  const ghApi = 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs/4567890'
  const leverApi = 'https://api.lever.co/v0/postings/otherco/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab'
  const f = stub({
    [ghApi]: { body: { id: 4567890, first_published: null, updated_at: '2026-11-24T10:00:00-05:00' } },
    [leverApi]: { body: { createdAt: Date.parse('2026-11-20T08:00:00Z') } },
  }).f
  assert.equal(await atsDate('https://boards.greenhouse.io/brightloop/jobs/4567890', f, NOW), null, 'the edited-only record stays undated')
  assert.equal((await atsDate('https://jobs.lever.co/otherco/9f1c2f7a-1b2c-4d5e-8f90-1234567890ab', f, NOW))?.date, '2026-11-20', 'an unrelated posting is unaffected')
})
