import assert from 'node:assert/strict'
import test from 'node:test'
import { freshBoardPostings } from '../lib/company-first/board-postings.ts'

const gh = (jobs: unknown[]) => async (u: string) => (u === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' ? { status: 200, body: JSON.stringify({ jobs }), finalUrl: u } : null) as never
const now = new Date('2026-11-21T12:00:00Z')

test('only roles inside the window, matching a request term, on an admitted board; newest best match per board', async () => {
  const http = gh([
    { id: 1, title: 'Sales Development Representative', first_published: '2026-11-01T00:00:00Z' },
    { id: 2, title: 'Sales Development Representative', first_published: '2026-08-01T00:00:00Z' },
    { id: 3, title: 'Backend Engineer', first_published: '2026-11-20T00:00:00Z' },
    { id: 4, title: 'SDR', first_published: '2026-11-30T00:00:00Z' },
  ])
  const out = await freshBoardPostings(['https://boards.greenhouse.io/acme/jobs/999', 'https://news.example/x'], { terms: ['sales', 'sdr'], windowDays: 45, now, http })
  assert.deepEqual(out, ['https://job-boards.greenhouse.io/acme/jobs/1'])
})
test('no terms, no admitted board, or an unreadable board gives nothing', async () => {
  const http = gh([{ id: 1, title: 'Sales Lead', first_published: '2026-11-01T00:00:00Z' }])
  assert.deepEqual(await freshBoardPostings(['https://boards.greenhouse.io/acme'], { terms: [], windowDays: 45, now, http }), [])
  assert.deepEqual(await freshBoardPostings(['https://acme.example/careers'], { terms: ['sales'], windowDays: 45, now, http }), [])
  assert.deepEqual(await freshBoardPostings(['https://boards.greenhouse.io/other'], { terms: ['sales'], windowDays: 45, now, http }), [])
})
test('the read deadline stops further board reads', async () => {
  let t = 0
  const http = async () => { t += 20_000; return { status: 200, body: JSON.stringify({ jobs: [{ id: 1, title: 'Sales Lead', first_published: '2026-11-01T00:00:00Z' }] }), finalUrl: '' } as never }
  const out = await freshBoardPostings(['https://boards.greenhouse.io/a', 'https://boards.greenhouse.io/b'], { terms: ['sales'], windowDays: 45, now, http, deadlineMs: 15_000, clock: () => t })
  assert.equal(out.length, 1)
})
test('two best roles per board, so a rejected top match does not hide the next; EU boards are not read (Qodo)', async () => {
  const http = gh([
    { id: 1, title: 'Sales Development Representative', first_published: '2026-11-01T00:00:00Z' },
    { id: 2, title: 'Sales Representative', first_published: '2026-11-02T00:00:00Z' },
  ])
  assert.deepEqual(await freshBoardPostings(['https://boards.greenhouse.io/acme'], { terms: ['sales', 'development'], windowDays: 45, now, http }),
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'https://job-boards.greenhouse.io/acme/jobs/2'])
  let asked = 0
  assert.deepEqual(await freshBoardPostings(['https://jobs.eu.lever.co/acme'], { terms: ['sales'], windowDays: 45, now, http: async () => { asked++; return null } }), [])
  assert.equal(asked, 0)
})
test('recruiter, intern and non-sales roles sharing a request word are not picked (Qodo)', async () => {
  const http = gh([
    { id: 1, title: 'SDR Recruiter', first_published: '2026-11-20T00:00:00Z' },
    { id: 2, title: 'Vendor Sales Intern', first_published: '2026-11-19T00:00:00Z' },
    { id: 3, title: 'SDR', first_published: '2026-10-20T00:00:00Z' },
  ])
  assert.deepEqual(await freshBoardPostings(['https://boards.greenhouse.io/acme'], { terms: ['sdr', 'sales'], windowDays: 45, now, http }), ['https://job-boards.greenhouse.io/acme/jobs/3'])
})

test('#1122 discovery volume: the board posting date filters BEFORE the 5-slot cap; in-window postings first, newest first', async () => {
  const { orderByBoardDate, postingKey } = await import('../lib/company-first/board-postings.ts')
  const dates = new Map<string, string>()
  await freshBoardPostings(['https://boards.greenhouse.io/acme'], { terms: ['sales'], windowDays: 45, now, dates, http: gh([
    { id: 1, title: 'Account Executive', first_published: '2023-08-01T00:00:00Z' },
    { id: 2, title: 'Engineer', first_published: '2026-11-10T00:00:00Z' },
    { id: 3, title: 'SDR', first_published: '2026-10-20T00:00:00Z' },
  ]) })
  assert.equal(dates.get(postingKey('https://boards.greenhouse.io/acme/jobs/1')!), '2023-08-01')
  const stale = 'https://boards.greenhouse.io/acme/jobs/1', older = 'https://job-boards.greenhouse.io/acme/jobs/3', newer = 'https://job-boards.greenhouse.io/acme/jobs/2'
  const out = orderByBoardDate(['https://news.example/a', stale, older, newer, 'https://news.example/b'], dates, { windowDays: 45, now })
  assert.deepEqual(out, [newer, older, 'https://news.example/a', 'https://news.example/b'])
  // no window: nothing dropped for age
  assert.ok(orderByBoardDate([stale], dates, { windowDays: null, now }).includes(stale))
})

test('#1122 discovery volume, Ashby shape (run a94417536: Complete 2023-08-22): a board-dated stale Ashby posting never takes a read slot', async () => {
  const { orderByBoardDate } = await import('../lib/company-first/board-postings.ts')
  const stale = 'https://jobs.ashbyhq.com/complete/f810333f-06ad-4729-85ea-5fba62257846', fresh = 'https://jobs.ashbyhq.com/complete/0b0c1f6e-1111-4a2b-9c3d-222233334444'
  const http = (async (u: string) => (u === 'https://api.ashbyhq.com/posting-api/job-board/complete' ? { status: 200, finalUrl: u, body: JSON.stringify({ jobs: [
    { title: 'Account Executive', isListed: true, publishedAt: '2023-08-22T10:00:00Z', jobUrl: stale },
    { title: 'Sales Development Representative', isListed: true, publishedAt: '2026-11-15T10:00:00Z', jobUrl: fresh },
  ] }) } : null)) as never
  const dates = new Map<string, string>()
  await freshBoardPostings([stale], { terms: ['sales'], windowDays: 45, now, http, dates })
  // the listed URL in its /application shape is the same posting
  assert.deepEqual(orderByBoardDate([stale + '/application', 'https://news.example/a', fresh], dates, { windowDays: 45, now }), [fresh, 'https://news.example/a'])
})
