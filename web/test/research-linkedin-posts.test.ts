// The research engine's person-first source (part F): public LinkedIn / X posts from the search index -> dated Candidates + authors.
// TEST-ONLY: invented people and handles; no network (the search is a fake).
import test from 'node:test'
import assert from 'node:assert/strict'
import { postDate, authorOf, postQueries, linkedinPostCandidates, authorPerson, authorSource, type IndexHit } from '../lib/research/sources/linkedin-engagers.ts'
import type { ResearchCase, ResearchPlan } from '../lib/research/types.ts'

// A LinkedIn activity ID / X status ID for a UTC day (the creation time sits in the top bits).
const liId = (day: string) => (BigInt(Date.parse(`${day}T12:00:00Z`)) << BigInt(22)).toString()
const xId = (day: string) => ((BigInt(Date.parse(`${day}T12:00:00Z`)) - BigInt(1288834974657)) << BigInt(22)).toString()
const liPost = (handle: string, day: string, slug = 'post') => `https://www.linkedin.com/posts/${handle}_${slug}-activity-${liId(day)}-AbCd`

test('the post ID is the date: LinkedIn activity / ugcPost IDs and X status IDs decode to their UTC day', () => {
  // real IDs from the prototype's hand-checked list (dated by the index and the post): 6 Nov 2026 and 18 Oct 2026
  assert.equal(postDate('https://www.linkedin.com/posts/jack-eliason_we-hired-our-first-sdr-this-week-not-a-activity-7524470489130586112-_HSO'), '2026-11-06')
  assert.equal(postDate('https://x.com/itsalexvacca/status/2111866674987376958'), '2026-10-18')
  assert.equal(postDate(liPost('dana-okoye', '2026-10-01')), '2026-10-01')
  assert.equal(postDate(`https://www.linkedin.com/posts/dana-okoye_x-ugcPost-${liId('2026-09-30')}-zz`), '2026-09-30')
  assert.equal(postDate(`https://x.com/danaokoye/status/${xId('2026-11-02')}`), '2026-11-02')
  for (const u of ['https://www.linkedin.com/in/dana-okoye', 'https://www.linkedin.com/posts/dana-okoye_no-id-here', 'https://example.com/posts/a_activity-7524470489130586112', 'https://x.com/danaokoye'])
    assert.equal(postDate(u), null, u)
})

test('the author is the post URL\'s own handle, with the display name its index title carries', () => {
  const u = liPost('dana-okoye', '2026-10-01')
  assert.deepEqual(authorOf({ url: u, title: "Dana Okoye's Post - LinkedIn" }), { platform: 'linkedin', handle: 'dana-okoye', name: 'Dana Okoye', profileUrl: 'https://www.linkedin.com/in/dana-okoye' })
  assert.equal(authorOf({ url: u, title: 'Dana Okoye on LinkedIn: we hired our first SDR' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'Dana Okoye posted on the topic' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'Ep 181 - three sites a week | Dana Okoye' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'Avoid random personalization in outbound' })?.name, null)
  assert.deepEqual(authorOf({ url: `https://x.com/danaokoye/status/${xId('2026-11-02')}`, title: 'Dana Okoye (@danaokoye) on X: cold email is not dead' }), { platform: 'x', handle: 'danaokoye', name: 'Dana Okoye', profileUrl: 'https://x.com/danaokoye' })
  assert.equal(authorOf({ url: 'https://x.com/i/status/2111866674987376958', title: 'x' }), null)
  assert.equal(authorOf({ url: 'https://www.linkedin.com/company/acme/', title: 'Acme' }), null)
})

const plan = (over: Partial<ResearchPlan> = {}): ResearchPlan => ({ persona: 'agency founder', decisionMakerTitles: ['Founder'], source: 'fallback', askingQueries: ['looking for lead generation agency Sydney'],
  triggers: [{ id: 't1', name: 'posts about outbound', why: '', footprint: '', queries: ['cold email agency Sydney', 'outbound agency Sydney'] }, { id: 't2', name: 'hiring SDR', why: '', footprint: '', queries: ['hiring SDR Sydney agency'] }, { id: 't3', name: 'off', why: '', footprint: '', queries: ['never searched'], enabled: false }], ...over })

test('the queries: every enabled trigger and the asking queries, per platform, round-robin across triggers, capped', () => {
  const q = postQueries(plan(), ['linkedin', 'x'], 50)
  assert.equal(q.length, 8)   // (2 + 1 + 1 asking) x 2 platforms; t3 is switched off
  assert.ok(q.every(x => x.q.startsWith(x.platform === 'linkedin' ? 'site:linkedin.com/posts ' : 'site:x.com ')))
  assert.ok(!q.some(x => /never searched/.test(x.q)))
  assert.deepEqual(postQueries(plan(), ['linkedin'], 3).map(x => x.triggerId), ['t1', 't2', 'ask'])   // a cap still reaches every trigger
})

const rc: ResearchCase = { tenant: 't', jobId: 'j', query: 'Sydney agencies posting about outbound', offer: 'outbound', where: 'Sydney, Australia', category: 'marketing agencies', windowDays: 90, today: '2026-11-15' }

test('posts become dated Candidates: window, same post once, company pages dropped, authors resolved within the cap', async () => {
  const calls: string[] = []
  const posts: IndexHit[] = [
    { url: liPost('dana-okoye', '2026-11-06', 'we-hired'), title: "Dana Okoye's Post", snippet: 'We hired our first SDR this week', date: '2026-11-07' },
    { url: liPost('dana-okoye', '2026-11-06', 'we-hired') + '?trk=x', title: "Dana Okoye's Post", snippet: 'duplicate with a tracking query', date: null },
    { url: liPost('acme-growth', '2026-10-20'), title: 'Acme Growth on LinkedIn: we are hiring', snippet: 'company page post', date: null },
    { url: liPost('old-news', '2026-05-01'), title: "Old News's Post", snippet: 'outside the 90-day window', date: '2026-11-01' },
    { url: liPost('rae-mendel', '2026-10-02'), title: 'Our outbound stack | Rae Mendel', snippet: 'our stack', date: null },
    { url: 'https://www.linkedin.com/pulse/some-article', title: 'An article', snippet: '', date: null },
    { url: `https://x.com/ivogrant/status/${xId('2026-10-30')}`, title: 'Ivo Grant on X: cold email works', snippet: 'cold email works', date: null },
  ]
  const search = async (q: string): Promise<IndexHit[] | null> => {
    calls.push(q)
    if (q.startsWith('site:linkedin.com/posts cold email')) return posts
    if (q.startsWith('site:')) return q.includes('hiring SDR') ? null : []
    if (q.includes('dana-okoye')) return [{ url: 'https://www.linkedin.com/in/dana-okoye/', title: 'Dana Okoye - Founder at Okoye Growth', snippet: 'Sydney, Australia', date: null }]
    if (q.includes('acme-growth')) return [{ url: 'https://www.linkedin.com/company/acme-growth', title: 'Acme Growth', snippet: '', date: null }]
    return []
  }
  const r = await linkedinPostCandidates(rc, plan(), { search, maxQueries: 8, maxResolve: 5 })
  assert.deepEqual(r.candidates.map(c => c.url).sort(), [liPost('dana-okoye', '2026-11-06', 'we-hired'), liPost('rae-mendel', '2026-10-02'), `https://x.com/ivogrant/status/${xId('2026-10-30')}`].sort())
  const dana = r.candidates.find(c => c.url.includes('dana-okoye'))!
  assert.equal(dana.date, '2026-11-06', 'the post ID date, not the index date')
  assert.equal(dana.via, 'engager'); assert.equal(dana.dated, 'registry'); assert.equal(dana.triggerId, 't1')
  assert.deepEqual(r.authors[dana.url], { platform: 'linkedin', handle: 'dana-okoye', name: 'Dana Okoye', profileUrl: 'https://www.linkedin.com/in/dana-okoye', kind: 'person', headline: 'Dana Okoye - Founder at Okoye Growth | Sydney, Australia' })
  assert.equal(r.authors[liPost('rae-mendel', '2026-10-02')].kind, 'unresolved')
  assert.equal(r.authors[`https://x.com/ivogrant/status/${xId('2026-10-30')}`].kind, 'unresolved')
  assert.deepEqual(r.funnel.dropped, { 'same post': 1, 'company page, not a person': 1, 'outside the window': 1, 'not a post URL': 1, 'search failed or capped': 2 })
  assert.equal(r.funnel.in, 7); assert.equal(r.funnel.out, 3)
  // each LinkedIn author is looked up once; X accounts are never looked up
  assert.equal(calls.filter(q => !q.startsWith('site:')).length, 3)
  // the resolve cap: with 1, only the first author is looked up and the rest stay 'unresolved' (kept, marked)
  calls.length = 0
  const capped = await linkedinPostCandidates(rc, plan(), { search, maxQueries: 8, maxResolve: 1 })
  assert.equal(calls.filter(q => !q.startsWith('site:')).length, 1)
  assert.equal(capped.authors[liPost('rae-mendel', '2026-10-02')].kind, 'unresolved')
})

test('an author becomes a Person only when the indexed profile names them with a role; the quote is the index text verbatim', () => {
  const base = { platform: 'linkedin' as const, handle: 'Dana-Okoye', name: 'Dana Okoye', profileUrl: 'https://www.linkedin.com/in/Dana-Okoye', kind: 'person' as const }
  const a = { ...base, headline: 'Dana Okoye - Founder at Okoye Growth | Sydney, Australia' }
  assert.deepEqual(authorSource(a), { id: 'profile:linkedin:dana-okoye', url: 'https://www.linkedin.com/in/Dana-Okoye', text: a.headline, kind: 'snippet' })
  assert.deepEqual(authorPerson(a), { name: 'Dana Okoye', title: 'Founder at Okoye Growth', sourceId: 'profile:linkedin:dana-okoye', quote: 'Dana Okoye - Founder at Okoye Growth', profileUrl: 'https://www.linkedin.com/in/Dana-Okoye', from: 'research' })
  assert.equal(authorPerson({ ...base, headline: '# Dana Okoye\n## Profile - Location: Sydney' }), null, 'no role next to the name')
  const md = { ...base, headline: 'Dana Okoye | # Dana Okoye\nLitigation Partner at Taft & Co\n## Profile\n- **Location:** Chicago' }
  assert.deepEqual(authorPerson(md), { name: 'Dana Okoye', title: 'Litigation Partner at Taft & Co', sourceId: 'profile:linkedin:dana-okoye', quote: 'Dana Okoye\nLitigation Partner at Taft & Co', profileUrl: 'https://www.linkedin.com/in/Dana-Okoye', from: 'research' })
  assert.ok(md.headline.includes(authorPerson(md)!.quote), 'the quote is verbatim index text')
  assert.equal(authorPerson({ ...base, headline: 'Dana Okoye | # Dana Okoye\n## About\nI help agencies' }), null)
  assert.equal(authorPerson({ ...base, headline: 'Rae Mendel - Founder at Acme' }), null, 'another name')
  assert.equal(authorPerson({ ...base, kind: 'unresolved', headline: 'Dana Okoye - Founder' }), null)
  assert.equal(authorPerson({ ...base, headline: null }), null)
})
