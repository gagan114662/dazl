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
