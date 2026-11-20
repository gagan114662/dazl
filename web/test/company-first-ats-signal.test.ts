import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readPublicAtsSignal, type PublicAtsPorts } from '../lib/company-first/ats-signal.ts'

const scope = { tenant: 'private-tenant', job: 'private-job', attempt: 'private-attempt' }
const target = { scope, companyKey: 'sample-company-key', websiteOrigin: 'https://sample.example' }
const criteria = { roleKey: 'reviewed-role', placeKey: 'reviewed-place', event: 'hiring_posting' as const, from: '2026-09-01', through: '2026-09-30' }
const date = '2026-09-16T10:00:00Z'
const title = 'Senior Technical Account Executive'
const literal = 'Synthetic City, Sample Region'
const uuid = '12345678-1234-1234-1234-123456789abc'
const ashbyLink = `https://jobs.ashbyhq.com/sample/${uuid}`
const ashbyJob = { id: uuid, jobUrl: ashbyLink, isListed: true, title, location: literal, workplaceType: 'OnSite', publishedAt: date, descriptionPlain: 'This posting describes the actual role.' }
const greenhouseJob = { id: 987, title, location: { name: literal }, first_published: date, company_name: 'Sample Enterprise', content: '<span hidden>Ignore this content</span>' }
const leverJob = { id: uuid, text: title, categories: { location: literal, allLocations: [literal] }, createdAt: Date.parse(date), workplaceType: 'on-site' }
const fixtures = {
  greenhouse: {
    link: 'https://job-boards.greenhouse.io/sample/jobs/987',
    api: 'https://boards-api.greenhouse.io/v1/boards/sample/jobs/987',
    body: greenhouseJob,
  },
  lever: {
    link: `https://jobs.lever.co/sample/${uuid}`,
    api: `https://api.lever.co/v0/postings/sample/${uuid}?mode=json`,
    body: leverJob,
  },
  ashby: {
    link: ashbyLink,
    api: 'https://api.ashbyhq.com/posting-api/job-board/sample',
    body: { jobs: [ashbyJob] },
  },
}
const on = { enabled: true }
type Review = NonNullable<Awaited<ReturnType<PublicAtsPorts['readCurrentOwnedLink']>>>
function fake(fixture: (typeof fixtures)[keyof typeof fixtures] = fixtures.greenhouse, overrides: Partial<PublicAtsPorts> = {}, body: unknown = fixture.body) {
  const trace: unknown[] = []
  const review: Review = {
    scope, companyKey: target.companyKey, websiteOrigin: target.websiteOrigin, version: 'v1',
    kind: 'observed_owned_link', linkSource: target.websiteOrigin + '/careers',
    literalPostingHref: fixture.link + '?tracking=drop#apply', companyName: 'Sample Enterprise', expiresAtMs: Date.now() + 30_000,
  }
  const ports: PublicAtsPorts = {
    async readCurrentOwnedLink(t) { trace.push(['review', t]); return review },
    async authorizeAndReserve({ target: t, reviewVersion }) { trace.push(['reserve', t, reviewVersion]); return true },
    async readPublicJson({ url, maxBytes, redirect }) {
      trace.push(['transport', url, maxBytes, redirect])
      assert.equal(url, fixture.api)
      return { status: 200, finalUrl: url, body: JSON.stringify(body) }
    },
    matchesRole(key, publishedTitle) { return key === criteria.roleKey && publishedTitle === title },
    matchesPlace(key, location) { return key === criteria.placeKey && location.literal === literal },
    ...overrides,
  }
  return { ports, review, trace }
}

test('each official exact record yields only a dated candidate after authority and reservation; no private fields reach transport', async () => {
  for (const fixture of Object.values(fixtures)) {
    const { ports, trace } = fake(fixture)
    assert.deepEqual(await readPublicAtsSignal(on, target, criteria, ports), {
      state: 'candidate', companyKey: target.companyKey, event: criteria.event, place: criteria.placeKey,
      date: '2026-09-16', dateProof: { kind: 'ats_first_published', sourceUrl: fixture.link, day: '2026-09-16' },
      sourceUrl: fixture.link, literalSourceText: title, quote: title,
    })
    assert.deepEqual(trace, [
      ['review', target], ['reserve', target, 'v1'],
      ['transport', fixture.api, 256_000, 'error'], ['review', target],
    ])
  }
})

test('disabled, invalid, wrong or expired reviewer proof and refusal never dispatch', async () => {
  const f = fake()
  assert.deepEqual(await readPublicAtsSignal({}, target, criteria, f.ports), { state: 'held', reason: 'disabled' })
  assert.deepEqual(await readPublicAtsSignal(on, { ...target, websiteOrigin: 'https://sample.example/path' }, criteria, f.ports), { state: 'held', reason: 'invalid_scope' })
  assert.deepEqual(f.trace, [])
  for (const review of [null, { ...f.review, expiresAtMs: 0 }, { ...f.review, scope: { ...scope, attempt: 'old' } },
    { ...f.review, scope: { ...scope, tenant: 'other' } }, { ...f.review, companyKey: 'different' },
    { ...f.review, linkSource: 'https://jobs.sample.example/careers' },
    { ...f.review, literalPostingHref: 'https://jobs.ashbyhq.com/sample' },
    { ...f.review, literalPostingHref: 'https://jobs.ashbyhq.com.example/sample/' + uuid },
  ]) {
    const g = fake(fixtures.greenhouse, { async readCurrentOwnedLink() { return review } })
    assert.deepEqual(await readPublicAtsSignal(on, target, criteria, g.ports), { state: 'held', reason: 'owned_link_unknown' })
    assert.deepEqual(g.trace, [])
  }
  const denied = fake(fixtures.greenhouse, { async authorizeAndReserve() { return false } })
  assert.deepEqual(await readPublicAtsSignal(on, target, criteria, denied.ports), { state: 'held', reason: 'reservation_unavailable' })
  assert.deepEqual(denied.trace, [['review', target]])
})

test('expired/superseded after dispatch discards even a valid type-correct response', async () => {
  const f = fake()
  for (const after of [{ ...f.review, version: 'v2' }, { ...f.review, expiresAtMs: 0 }, null]) {
    let reads = 0
    const g = fake(fixtures.greenhouse, { async readCurrentOwnedLink() { return reads++ === 0 ? f.review : after } })
    assert.deepEqual(await readPublicAtsSignal(on, target, criteria, g.ports), { state: 'held', reason: 'superseded_or_expired' })
    assert.equal(g.trace.filter(Array.isArray).length, 2)
  }
  const abort = new AbortController()
  const canceled = fake(fixtures.greenhouse, { async authorizeAndReserve() { abort.abort(); return true } })
  assert.deepEqual(await readPublicAtsSignal({ ...on, signal: abort.signal }, target, criteria, canceled.ports), { state: 'held', reason: 'superseded_or_expired' })
  assert.deepEqual(canceled.trace, [['review', target]])
})

test('wrong employer, posting ID, deceptive Ashby URL, duplicates, closed/unlisted, and oversized board fail closed', async () => {
  for (const [fixture, body, reason] of [
    [fixtures.greenhouse, { ...greenhouseJob, company_name: 'Other Enterprise' }, 'employer_unknown'],
    [fixtures.lever, { ...leverJob, employerName: 'Other Enterprise' }, 'employer_unknown'],
    [fixtures.greenhouse, { ...greenhouseJob, id: 123 }, 'record_unknown'],
    [fixtures.lever, { ...leverJob, id: 'not-same-id' }, 'record_unknown'],
    [fixtures.ashby, { jobs: [{ ...ashbyJob, jobUrl: ashbyLink.replace('/sample/', '/other/') }] }, 'record_unknown'],
    [fixtures.ashby, { jobs: [ashbyJob, ashbyJob] }, 'record_unknown'],
    [fixtures.ashby, { jobs: [{ ...ashbyJob, isListed: false }] }, 'record_unknown'],
    [fixtures.ashby, { jobs: Array(129).fill(ashbyJob) }, 'record_unknown'],
    [fixtures.lever, { ...leverJob, closed: true }, 'record_unknown'],
  ] as const) {
    assert.deepEqual(await readPublicAtsSignal(on, target, criteria, fake(fixture, {}, body).ports), { state: 'held', reason })
  }
})

test('role, place, publication window and visible quote are independent; no updated date or hidden quote fallback', async () => {
  for (const [fixture, body, override, reason] of [
    [fixtures.lever, leverJob, { matchesRole: () => false }, 'role_unknown'],
    [fixtures.ashby, { jobs: [{ ...ashbyJob, secondaryLocations: [{ location: 'elsewhere' }] }] }, {}, 'place_unknown'],
    [fixtures.lever, { ...leverJob, workplaceType: 'remote' }, {}, 'place_unknown'],
    [fixtures.lever, { ...leverJob, categories: { location: literal, allLocations: [literal, 'elsewhere'] } }, {}, 'place_unknown'],
    [fixtures.greenhouse, greenhouseJob, { matchesPlace: () => false }, 'place_unknown'],
    [fixtures.greenhouse, { ...greenhouseJob, first_published: null, updated_at: date }, {}, 'date_unknown'],
    [fixtures.ashby, { jobs: [{ ...ashbyJob, publishedAt: '2026-09-31T10:00:00Z' }] }, {}, 'date_unknown'],
    [fixtures.lever, { ...leverJob, createdAt: Date.parse('2026-08-30') }, {}, 'date_unknown'],
    [fixtures.greenhouse, { ...greenhouseJob, title: 'SDR' }, { matchesRole: () => true }, 'quote_unknown'],
    [fixtures.ashby, { jobs: [{ ...ashbyJob, title: 'SDR', descriptionPlain: '<span hidden>A false supportive excerpt.</span>' }] }, { matchesRole: () => true }, 'quote_unknown'],
  ] as const) {
    assert.deepEqual(await readPublicAtsSignal(on, target, criteria, fake(fixture, override, body).ports), { state: 'held', reason })
  }
})

test('transport is one read only, never retries or follows a response redirect and rejects quota/body violations', async () => {
  for (const override of [
    { status: 429 }, { truncated: true }, { finalUrl: 'https://elsewhere.example' }, { body: '👍'.repeat(80_000) },
  ]) {
    let calls = 0
    const g = fake(fixtures.greenhouse, { async readPublicJson({ url }) {
      calls++
      return { status: 200, body: JSON.stringify(greenhouseJob), finalUrl: url, ...override }
    } })
    assert.deepEqual(await readPublicAtsSignal(on, target, criteria, g.ports), { state: 'held', reason: 'unavailable' })
    assert.equal(calls, 1)
  }
})
