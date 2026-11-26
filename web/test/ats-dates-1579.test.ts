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

test('DATES Workable reads its published field', async () => {
  const wu = 'https://apply.workable.com/brightloop/j/1A2B3C4D5E/'
  const wapi = 'https://apply.workable.com/api/v1/accounts/brightloop/jobs/1A2B3C4D5E'
  assert.equal((await atsDate(wu, stub({ [wapi]: { body: { published_on: '2026-11-19', created_at: '2026-11-17' } } }).f, NOW))?.date, '2026-11-19')
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
  const api = 'https://apply.workable.com/api/v1/widget/accounts/brightloop?details=true'
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

// The same rule has to hold for any board, industry and country: the reader knows boards, not businesses. One board per platform,
// four different industries in four different countries, and a posting looked up in the wrong board's index must give nothing.
test('DATES board index pages date postings for any industry and country, and never across boards', async () => {
  const { atsList, atsListDate } = await import('../lib/discover/ats-dates.ts')
  const boards = [
    { index: 'https://boards.greenhouse.io/northlinecare', posting: 'https://boards.greenhouse.io/northlinecare/jobs/4466', body: { jobs: [{ id: '4466', absolute_url: 'https://boards.greenhouse.io/northlinecare/jobs/4466', first_published: '2026-11-17T00:00:00Z' }] } },
    { index: 'https://jobs.eu.lever.co/hafenwerk', posting: 'https://jobs.eu.lever.co/hafenwerk/11111111-2222-3333-4444-555555555555', body: [{ id: '11111111-2222-3333-4444-555555555555', hostedUrl: 'https://jobs.eu.lever.co/hafenwerk/11111111-2222-3333-4444-555555555555', createdAt: Date.parse('2026-11-18T00:00:00Z') }] },
    { index: 'https://jobs.ashbyhq.com/harbourlegal', posting: 'https://jobs.ashbyhq.com/harbourlegal/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', body: { jobs: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', jobUrl: 'https://jobs.ashbyhq.com/harbourlegal/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', publishedAt: '2026-11-19T00:00:00Z' }] } },
    { index: 'https://werkstatt.workable.com/', posting: 'https://apply.workable.com/werkstatt/j/ZZ9Y8X7W', body: { jobs: [{ shortcode: 'ZZ9Y8X7W', url: 'https://apply.workable.com/werkstatt/j/ZZ9Y8X7W', published_on: '2026-11-20' }] } },
  ]
  for (const b of boards) {
    const rec = atsList(b.index)
    assert.ok(rec, `${b.index} is a board index`)
    const own = await atsListDate(b.index, b.posting, stub({ [rec.apiUrl]: { body: b.body } }).f, NOW)
    assert.ok(own, `${b.index} dates its own posting`)
    assert.equal(own.sourceUrl, rec.apiUrl)
  }
  // the fail-closed half: a different board's index cannot date this posting, even when it lists postings
  const other = atsList('https://boards.greenhouse.io/northlinecare')!
  assert.equal(await atsListDate('https://boards.greenhouse.io/northlinecare', boards[3].posting, stub({ [other.apiUrl]: { body: boards[0].body } }).f, NOW), null, 'a posting from another board is not dated here')
})

// Diagnosis on a live Workable board (2026-11-26): the single record is /api/v1/accounts/<board>/jobs/<shortcode> and prints the day as
// `published`; the list record is the account widget, /api/v1/widget/accounts/<board>?details=true, with jobs[].published_on. The
// guessed /api/v1/accounts/<board>/jobs?details=true answers 400. Workable also serves a locale-prefixed path.
test('DATES Workable: the account widget is the list record and a locale prefix still names the posting', async () => {
  const { atsList, atsListDate, atsPosting } = await import('../lib/discover/ats-dates.ts')
  const index = 'https://apply.workable.com/degura/'
  const rec = atsList(index)
  assert.equal(rec?.apiUrl, 'https://apply.workable.com/api/v1/widget/accounts/degura?details=true', 'the list is the account widget')
  const localised = 'https://apply.workable.com/en/degura/j/B48FCABF70'
  const single = atsPosting(localised)
  assert.equal(single?.platform, 'workable')
  assert.equal(single?.apiUrl, 'https://apply.workable.com/api/v1/accounts/degura/jobs/B48FCABF70')
  const own = await atsDate(localised, stub({ [single!.apiUrl]: { body: { shortcode: 'B48FCABF70', published: '2026-11-19T00:00:00.000Z' } } }).f, NOW)
  assert.equal(own?.date, '2026-11-19', 'the record prints the day as published')
  const listed = await atsListDate(index, localised, stub({ [rec!.apiUrl]: { body: { jobs: [{ shortcode: 'B48FCABF70', url: 'https://apply.workable.com/j/B48FCABF70', published_on: '2026-11-19' }] } } }).f, NOW)
  assert.equal(listed?.date, '2026-11-19', 'the widget list dates the same posting')

})

// A fifth board, verified before the code: a SmartRecruiters posting page is /<company>/<id>-<slug>, and the platform serves the same
// posting at api.smartrecruiters.com/v1/companies/<company>/postings/<id> with the day in `releasedDate`. The body below is the real
// record fetched on 2026-11-26; the company, its name and its id stay here and out of product code.
const SR = {
  id: '744000158320111',
  name: 'Senior / Lead Engineering Operations Manager',
  releasedDate: '2026-10-28T15:14:43.941Z',
  postingUrl: 'https://jobs.smartrecruiters.com/smartrecruiters/744000158320111-senior-lead-engineering-operations-manager',
}
const SR_PAGE = 'https://jobs.smartrecruiters.com/SmartRecruiters/744000158320111-senior-lead-engineering-operations-manager'
const SR_API = 'https://api.smartrecruiters.com/v1/companies/SmartRecruiters/postings/744000158320111'

test('DATES SmartRecruiters: a posting page dates itself from its company record', async () => {
  const { atsPosting } = await import('../lib/discover/ats-dates.ts')
  assert.equal(atsPosting(SR_PAGE)?.platform, 'smartrecruiters')
  assert.equal(atsPosting(SR_PAGE)?.apiUrl, SR_API)
  const d = await atsDate(SR_PAGE, stub({ [SR_API]: { body: SR } }).f, NOW)
  assert.deepEqual(d, { date: '2026-10-28', sourceUrl: SR_API, platform: 'smartrecruiters' })
})

test('DATES SmartRecruiters fails closed: no releasedDate, a future day, a stale day', async () => {
  const noDate = Object.fromEntries(Object.entries(SR).filter(([k]) => k !== 'releasedDate'))
  assert.equal(await atsDate(SR_PAGE, stub({ [SR_API]: { body: noDate } }).f, NOW), null, 'no releasedDate means no date')
  assert.equal(await atsDate(SR_PAGE, stub({ [SR_API]: { body: { ...SR, releasedDate: '2027-03-01T00:00:00Z' } } }).f, NOW), null, 'a future day is refused')
  assert.equal(await atsDate(SR_PAGE, stub({ [SR_API]: { body: { ...SR, releasedDate: '2019-01-02T00:00:00Z' } } }).f, NOW), null, 'a day outside the window is refused')
})

test('DATES SmartRecruiters control: the other four boards are untouched by the new branch', async () => {
  const gh = 'https://boards.greenhouse.io/northlinecare/jobs/4466'
  const ghApi = 'https://boards-api.greenhouse.io/v1/boards/northlinecare/jobs/4466'
  const d = await atsDate(gh, stub({ [ghApi]: { body: { id: 4466, first_published: '2026-11-17T00:00:00Z' } } }).f, NOW)
  assert.equal(d?.date, '2026-11-17')
  assert.equal((await import('../lib/discover/ats-dates.ts')).atsPosting('https://jobs.smartrecruiters.com/')?.platform ?? null, null, 'a board root is not a posting')
})

// Live shape check: Greenhouse's current board host is job-boards.greenhouse.io, and its list entries link absolute_url on that host.
// Verified against the real board on 2026-11-26 (list and single record agree: 2026-10-14).
test('DATES a job-boards.greenhouse.io board and posting are the same board', async () => {
  const { atsList, atsListDate, atsPosting } = await import('../lib/discover/ats-dates.ts')
  const index = 'https://job-boards.greenhouse.io/northlinecare'
  const posting = 'https://job-boards.greenhouse.io/northlinecare/jobs/4466'
  assert.equal(atsList(index)?.apiUrl, 'https://boards-api.greenhouse.io/v1/boards/northlinecare/jobs')
  assert.equal(atsPosting(posting)?.apiUrl, 'https://boards-api.greenhouse.io/v1/boards/northlinecare/jobs/4466')
  const d = await atsListDate(index, posting, stub({ 'https://boards-api.greenhouse.io/v1/boards/northlinecare/jobs': { body: { jobs: [{ id: 4466, absolute_url: posting, first_published: '2026-11-17T00:00:00Z' }] } } }).f, NOW)
  assert.deepEqual(d, { date: '2026-11-17', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/northlinecare/jobs', platform: 'greenhouse' })
})

// Two readers exist for the same postings: lib/sources/ats-posting.ts (the verifier's, #460/#533) and lib/discover/ats-dates.ts
// (mine). They must name the same day for the same body, or a lead is dated two ways depending on which path saw it. The
// `updated_at` control is the reason: both readers must ignore it and read the platform's first-published field.
test('DATES parity: both readers name the same day, and neither falls back to updated_at', async () => {
  const dates = await import('../lib/discover/ats-dates.ts')
  const { atsPostingRef, atsRecord } = await import('../lib/sources/ats-posting.ts')
  const cases = [
    { page: 'https://boards.greenhouse.io/northlinecare/jobs/4466', body: { id: 4466, title: 't', first_published: '2026-11-17T00:00:00Z', updated_at: '2026-11-24T00:00:00Z' }, day: '2026-11-17' },
    { page: 'https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b', body: { id: 'ad208490-4052-4f91-a57e-433f2d1e484b', text: 't', createdAt: 1756512000000, updatedAt: 1764115200000 }, day: '2025-08-30' },
    { page: 'https://jobs.ashbyhq.com/northlinecare/0f0a1f8e-2f9b-4c54-9d3f-1a2b3c4d5e6f', body: { jobs: [{ id: '0f0a1f8e-2f9b-4c54-9d3f-1a2b3c4d5e6f', title: 't', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/northlinecare/0f0a1f8e-2f9b-4c54-9d3f-1a2b3c4d5e6f', publishedAt: '2026-11-18T12:00:00Z', updatedAt: '2026-11-25T12:00:00Z' }] }, day: '2026-11-18' },
  ]
  for (const c of cases) {
    const mine = await dates.atsDate(c.page, stub({ [dates.atsPosting(c.page)!.apiUrl]: { body: c.body } }).f, NOW, 3650)
    const theirs = atsRecord(c.body, atsPostingRef(c.page)!) as { posted: string | null } | null
    assert.equal(mine?.date, c.day, `discover reader: ${c.page}`)
    assert.equal(theirs?.posted, c.day, `verifier reader: ${c.page}`)
  }
})

