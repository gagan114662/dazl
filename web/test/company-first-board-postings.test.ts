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

test('Qodo #1548: within in-window board postings, requested-role titles first (newest first), then other roles, then undated', async () => {
  const { orderByBoardDate } = await import('../lib/company-first/board-postings.ts')
  const { requestedGateRoles } = await import('../lib/scan/sales-hiring-gate.ts')
  const { matchedHiringRole } = await import('../lib/scan/hiring-role-match.ts')
  const roles = requestedGateRoles('Find B2B companies hiring their first SDR/BDR or sales rep', null)
  assert.ok(roles.length > 0)
  const dates = new Map<string, string>(), titles = new Map<string, string>()
  await freshBoardPostings(['https://boards.greenhouse.io/acme'], { terms: ['sales'], windowDays: 45, now, dates, titles, http: gh([
    { id: 1, title: 'Customer Success Manager', first_published: '2026-11-20T00:00:00Z' },
    { id: 2, title: 'Sales Development Representative', first_published: '2026-10-20T00:00:00Z' },
    { id: 3, title: 'BDR', first_published: '2026-11-01T00:00:00Z' },
    { id: 4, title: 'Marketing Manager', first_published: '2026-11-10T00:00:00Z' },
  ]) })
  const u = (id: number) => `https://job-boards.greenhouse.io/acme/jobs/${id}`
  const out = orderByBoardDate(['https://news.example/a', u(1), u(2), u(3), u(4)], dates, { windowDays: 45, now, titles, roleMatch: t => !!matchedHiringRole(t, roles) })
  assert.deepEqual(out, [u(3), u(2), u(1), u(4), 'https://news.example/a'])
})

// Run af02437c: 39 boards cited, 2 read; Automat (2025-04-30) and Cognition (2025-11-18) Ashby SDR postings took read slots undated.
test('af02437c: every ATS posting slot candidate gets its own board dated (past the 8-board pick cap), so a stale one is dropped', async () => {
  const { dateBoards, orderByBoardDate } = await import('../lib/company-first/board-postings.ts')
  const ash = (org: string, id: string, at: string) => ({ jobs: [{ id, title: 'Sales Development Representative', publishedAt: at, jobUrl: `https://jobs.ashbyhq.com/${org}/${id}`, isListed: true }] })
  const bodies: Record<string, unknown> = {
    'https://api.ashbyhq.com/posting-api/job-board/automat?includeCompensation=false': ash('automat', 'f1b67be7-60cd-4067-9f33-43c095188d82', '2025-04-30T02:10:32.968+00:00'),
    'https://api.ashbyhq.com/posting-api/job-board/cognition?includeCompensation=false': ash('cognition', '001a11ed-d7bb-4c78-a260-1d28c12bf61a', '2025-11-18T16:22:24.715+00:00'),
    'https://api.ashbyhq.com/posting-api/job-board/fresh?includeCompensation=false': ash('fresh', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-11-10T00:00:00+00:00'),
  }
  const http = async (u: string) => { const k = Object.keys(bodies).find(x => x.split('?')[0] === u.split('?')[0]); return (k ? { status: 200, body: JSON.stringify(bodies[k]), finalUrl: u } : { status: 404, body: '', finalUrl: u }) as never }
  const filler = Array.from({ length: 9 }, (_, i) => `https://boards.greenhouse.io/filler${i}/jobs/${i + 1}`)
  const urls = [...filler, 'https://jobs.ashbyhq.com/automat/f1b67be7-60cd-4067-9f33-43c095188d82', 'https://jobs.ashbyhq.com/cognition/001a11ed-d7bb-4c78-a260-1d28c12bf61a', 'https://jobs.ashbyhq.com/fresh/aaaaaaaa-0000-0000-0000-000000000001', 'https://news.example/a']
  const dates = new Map<string, string>(), titles = new Map<string, string>()
  const st = await dateBoards(urls, { http, deadlineMs: 8_000, dates, titles })
  assert.equal(st.boards, 12); assert.equal(st.read, 3); assert.equal(st.failed, 9); assert.equal(st.cause, 'unreadable')
  const out = orderByBoardDate(urls, dates, { windowDays: 45, now })
  assert.equal(out[0], 'https://jobs.ashbyhq.com/fresh/aaaaaaaa-0000-0000-0000-000000000001')
  assert.ok(!out.some(u => /automat|cognition/.test(u)), out.join(' '))
})
test('af02437c: an undated ATS posting (board unread) never beats a dated in-window one, and stays after undated non-ATS sources', async () => {
  const { orderByBoardDate } = await import('../lib/company-first/board-postings.ts')
  const dates = new Map([['greenhouse:acme:1', '2026-11-10']])
  const out = orderByBoardDate(['https://jobs.ashbyhq.com/x/11111111-0000-0000-0000-000000000000', 'https://news.example/a', 'https://job-boards.greenhouse.io/acme/jobs/1'], dates, { windowDays: 45, now, boardsDated: true } as never)
  assert.deepEqual(out, ['https://job-boards.greenhouse.io/acme/jobs/1', 'https://news.example/a', 'https://jobs.ashbyhq.com/x/11111111-0000-0000-0000-000000000000'])
})
test('af02437c: the dating step has its own deadline; when it runs out the cause is "deadline"', async () => {
  const { dateBoards } = await import('../lib/company-first/board-postings.ts')
  let t = 0
  const http = async () => { t += 5_000; return { status: 200, body: JSON.stringify({ jobs: [] }), finalUrl: '' } as never }
  const st = await dateBoards(['https://boards.greenhouse.io/a/jobs/1', 'https://boards.greenhouse.io/b/jobs/2', 'https://boards.greenhouse.io/c/jobs/3'], { http, deadlineMs: 8_000, clock: () => t, concurrency: 1 })
  assert.equal(st.boards, 3); assert.equal(st.read, 2); assert.equal(st.cause, 'deadline')
})

// Qodo #1552 (1): each board gets its own deadline when a worker takes it (deadlineMs), inside a separate whole-step cap (totalMs), so later
// boards in a long queue are still read. (3): every board not dated, skipped at the deadline or timed out, is counted in failed.
test('Qodo #1552: later boards are read on their own deadline; skipped boards count as failed', async () => {
  const { dateBoards } = await import('../lib/company-first/board-postings.ts')
  let t = 0
  const http = async () => { t += 5_000; return { status: 200, body: JSON.stringify({ jobs: [] }), finalUrl: '' } as never }
  const urls = Array.from({ length: 8 }, (_, i) => `https://boards.greenhouse.io/b${i}/jobs/${i + 1}`)
  const st = await dateBoards(urls, { http, deadlineMs: 8_000, totalMs: 30_000, clock: () => t, concurrency: 1 } as never)
  assert.equal(st.read, 6, 'six 5s boards fit the 30s step though each is past the 8s mark')
  assert.equal(st.failed, 2, 'the two boards the step could not reach are failed, not silent'); assert.equal(st.cause, 'deadline')
})
// Qodo #1552 (2): when no board dating ran, an undated ATS posting keeps its place (only a dated run demotes it).
test('Qodo #1552: without board dating, undated ATS postings keep their order', async () => {
  const { orderByBoardDate } = await import('../lib/company-first/board-postings.ts')
  const urls = ['https://job-boards.greenhouse.io/acme/jobs/1', 'https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://d.example/4', 'https://e.example/5']
  assert.deepEqual(orderByBoardDate(urls, new Map(), { windowDays: 45, now }), urls)
})
