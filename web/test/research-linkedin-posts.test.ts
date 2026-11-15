// The research engine's person-first source (part F): public LinkedIn / X posts from the search index -> dated Candidates + authors.
// TEST-ONLY: invented people and handles; no network (the search is a fake).
import test from 'node:test'
import assert from 'node:assert/strict'
import { postDate, authorOf, postQueries, linkedinPostCandidates, authorPerson, authorSource, postKey, readsAsRole, nameShaped, type IndexHit } from '../lib/research/sources/linkedin-engagers.ts'
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
  assert.deepEqual(authorOf({ url: u, title: "Dana Okoye's Post - LinkedIn" }), { platform: 'linkedin', handle: 'dana-okoye', name: 'Dana Okoye', profileUrl: null }, 'no /in/ URL until the handle is resolved to this person')
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
  assert.deepEqual(postQueries(plan(), ['linkedin', 'x'], 2).map(x => x.platform), ['linkedin', 'x'], 'a small cap still reaches both platforms')
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
  assert.deepEqual(r.funnel.dropped, { 'same post': 1, 'company page, not a person': 1, 'outside the window': 1, 'not a post URL': 1 })
  assert.equal(r.funnel.in, 7); assert.equal(r.funnel.out, 3)
  assert.equal(r.funnel.in - r.funnel.out, Object.values(r.funnel.dropped).reduce((a, b) => a + b, 0), 'in - out = the per-hit drops')
  assert.equal(r.searches.failed, 2)
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

test('review: a role must read as a role; the same post through another host or a fragment is one post', async () => {
  const base = { platform: 'linkedin' as const, handle: 'dana-okoye', name: 'Dana Okoye', profileUrl: 'https://www.linkedin.com/in/dana-okoye', kind: 'person' as const }
  for (const h of ['Dana Okoye - LinkedIn | x', 'Dana Okoye - Acme Corp | LinkedIn', 'Dana Okoye - Greater Boston | x', 'Dana Okoye | # Dana Okoye\nGreater Boston\n## About'])
    assert.equal(authorPerson({ ...base, headline: h }), null, h)
  for (const [h, t] of [['Dana Okoye - Head of Growth | x', 'Head of Growth'], ['Dana Okoye | # Dana Okoye\nPartner at Taft\n', 'Partner at Taft']] as const)
    assert.equal(authorPerson({ ...base, headline: h })?.title, t, h)
  assert.equal(readsAsRole('Founder & CEO | LinkedIn'), true)
  const id = liId('2026-10-10')
  assert.equal(postKey(`https://www.linkedin.com/posts/dana_x-activity-${id}-ab`), postKey(`https://uk.linkedin.com/posts/dana_x-activity-${id}-ab#c`))
  assert.equal(postKey(`https://x.com/dana/status/${xId('2026-10-10')}`), postKey(`https://twitter.com/dana/status/${xId('2026-10-10')}?s=20`))
  const hits: IndexHit[] = [{ url: `https://www.linkedin.com/posts/dana-okoye_x-activity-${id}-ab`, title: "Dana Okoye's Post", snippet: 'a', date: null }, { url: `https://uk.linkedin.com/posts/dana-okoye_x-activity-${id}-ab#c`, title: "Dana Okoye's Post", snippet: 'b', date: null }]
  const r = await linkedinPostCandidates(rc, plan(), { search: async q => (q.startsWith('site:linkedin.com/posts cold email agency') ? hits : []), maxQueries: 2, maxResolve: 0 })
  assert.equal(r.candidates.length, 1); assert.equal(r.funnel.dropped['same post'], 1)
})

test('review (opus): a company handle that is also a member vanity is the company; names come from the post title only; title tails are not names', async () => {
  const id = liId('2026-10-12')
  const post = `https://www.linkedin.com/posts/stripe_payments-activity-${id}-ab`
  const search = async (q: string): Promise<IndexHit[] | null> => q.startsWith('site:linkedin.com/posts cold email agency')
    ? [{ url: post, title: 'New payments API launch', snippet: 'x', date: null }, { url: liPost('dana-okoye', '2026-10-13'), title: 'We hired our first SDR | Dana Okoye | 15 comments', snippet: 'y', date: null }]
    : q.includes('stripe') ? [{ url: 'https://www.linkedin.com/in/stripe', title: 'John Smith - Founder at Smith Co', snippet: '', date: null }, { url: 'https://www.linkedin.com/company/stripe', title: 'Stripe', snippet: '', date: null }]
    : q.includes('dana-okoye') ? [{ url: 'https://www.linkedin.com/in/dana-okoye', title: 'Dana Okoye - Head of Growth at Okoye', snippet: '', date: null }] : []
  const r = await linkedinPostCandidates(rc, plan(), { search, maxQueries: 2, maxResolve: 5 })
  // an unnamed post is not resolved (it can never be a Person): kept as 'unresolved', with no /in/ URL, never credited to the member
  assert.equal(r.authors[post].kind, 'unresolved'); assert.equal(r.authors[post].profileUrl, null); assert.equal(authorPerson(r.authors[post]), null)
  // a NAMED author whose handle is also a company page is the company (dropped), even when a member owns the same /in/ vanity
  const named = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [{ url: post, title: 'Stripe Payments on LinkedIn: new payments API', snippet: 'x', date: null }] : q.includes('stripe') ? [{ url: 'https://www.linkedin.com/in/stripe', title: 'John Smith - Founder at Smith Co', snippet: '', date: null }, { url: 'https://www.linkedin.com/company/stripe', title: 'Stripe', snippet: '', date: null }] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(named.candidates.length, 0); assert.equal(named.funnel.dropped['company page, not a person'], 1)
  // a one-word title name ("Stripe") is not a person's name: no lookup is spent; the post stays 'unresolved' and can never be a Person
  const one = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [{ url: post, title: 'Stripe on LinkedIn: new payments API', snippet: 'x', date: null }] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(one.authors[post].kind, 'unresolved'); assert.equal(one.authors[post].name, null); assert.equal(one.searches.sent, 2)
  const dana = r.authors[liPost('dana-okoye', '2026-10-13')]
  assert.equal(dana.name, 'Dana Okoye'); assert.equal(dana.kind, 'person'); assert.equal(dana.profileUrl, 'https://www.linkedin.com/in/dana-okoye')
  // a post with no name in its title is never a Person, even when an /in/ profile with that handle exists
  const r2 = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [{ url: liPost('jsmith', '2026-10-12'), title: 'New payments API launch', snippet: 'x', date: null }] : q.includes('jsmith') ? [{ url: 'https://www.linkedin.com/in/jsmith', title: 'John Smith - Founder at Smith Co', snippet: '', date: null }] : [], maxQueries: 2, maxResolve: 5 })
  const js = r2.authors[liPost('jsmith', '2026-10-12')]
  assert.equal(js.kind, 'unresolved'); assert.equal(js.profileUrl, null); assert.equal(authorPerson(js), null)
  const u = liPost('dana-okoye', '2026-10-01')
  assert.equal(authorOf({ url: u, title: 'We hired our first SDR | Dana Okoye | 15 comments' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'We hired our first SDR | LinkedIn' })?.name, null)
  assert.equal(authorOf({ url: u, title: 'Why outbound on LinkedIn is dead | Dana Okoye' })?.name, 'Dana Okoye')
  assert.equal(postDate(`https://www.linkedin.com/posts/dana_x-activity-${id}9-ab`), null, 'a 20-digit run is not an ID')
  const base = { platform: 'linkedin' as const, handle: 'dana-okoye', name: 'Dana Okoye', profileUrl: 'https://www.linkedin.com/in/dana-okoye', kind: 'person' as const }
  for (const h of ['Dana Okoye - Sydney, New South Wales, Australia | Professional Profile | LinkedIn', 'Dana Okoye - Okoye Growth | LinkedIn', 'Dana Okoye | # Dana Okoye\n500+ connections\n', 'Dana Okoye | # Dana Okoye\nSydney, New South Wales, Australia\n'])
    assert.equal(authorPerson({ ...base, headline: h }), null, h)
  // a search that throws counts as failed; what was found is kept
  const r3 = await linkedinPostCandidates(rc, plan(), { search: async q => { if (!q.startsWith('site:linkedin.com/posts cold email agency')) throw new Error('boom'); return [{ url: u, title: "Dana Okoye's Post", snippet: 'z', date: null }] }, maxQueries: 3, maxResolve: 1 })
  assert.equal(r3.candidates.length, 1); assert.ok(r3.searches.failed >= 2)
})

test('review (haiku): the window is [today - windowDays, today]; an X-only result is kept; a hit without a title does not crash', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  const hits = [mk(liPost('future', '2026-11-20'), "Fu Ture's Post"), mk(liPost('edge-in', '2026-08-17'), "Ed Gein's Post"), mk(liPost('edge-out', '2026-08-16'), "Ed Gout's Post"),
    { url: liPost('notitle', '2026-10-01'), title: undefined as unknown as string, snippet: '', date: null }]
  const r = await linkedinPostCandidates(rc, plan(), { search: async q => (q.startsWith('site:linkedin.com/posts cold email agency') ? hits : q.startsWith('site:x.com cold email agency') ? [mk(`https://x.com/ivogrant/status/${xId('2026-10-30')}`, 'Ivo Grant on X: hi')] : []), maxQueries: 4, maxResolve: 0 })
  const urls = r.candidates.map(c => c.url)
  assert.ok(!urls.includes(liPost('future', '2026-11-20')), 'after today')
  assert.ok(urls.includes(liPost('edge-in', '2026-08-17')), 'today - 90 days is inside')
  assert.ok(!urls.includes(liPost('edge-out', '2026-08-16')), 'one day earlier is outside')
  assert.ok(urls.includes(liPost('notitle', '2026-10-01')))
  const x = r.candidates.find(c => c.url.startsWith('https://x.com/'))
  assert.ok(x && x.query.startsWith('site:x.com '), 'found by the X query')
  assert.equal(r.authors[x!.url].profileUrl, 'https://x.com/ivogrant'); assert.equal(r.authors[x!.url].kind, 'unresolved')
})

test('review round 2 (opus): a profile is the author only when its own title names them; a later named post still resolves the handle', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  const wrong = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('rae-mendel', '2026-10-10'), 'Dana Okoye on LinkedIn: great')] : q.includes('rae-mendel') ? [mk('https://www.linkedin.com/in/rae-mendel', 'Rae Mendel - CEO at Mendel')] : [], maxQueries: 2, maxResolve: 5 })
  const w = wrong.authors[liPost('rae-mendel', '2026-10-10')]
  assert.equal(w.kind, 'unresolved'); assert.equal(w.profileUrl, null); assert.equal(authorSource(w), null)
  const later = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-10', 'a'), 'Big launch'), mk(liPost('dana-okoye', '2026-10-11', 'b'), "Dana Okoye's Post")] : q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoye - Founder at Okoye')] : [], maxQueries: 2, maxResolve: 5 })
  const b = later.authors[liPost('dana-okoye', '2026-10-11', 'b')]
  assert.equal(b.kind, 'person'); assert.equal(b.name, 'Dana Okoye'); assert.equal(authorPerson(b)?.title, 'Founder at Okoye')
  assert.equal(later.searches.sent, 3, 'two post queries + one resolve')
  for (const r of ['Looking at options', 'Eat at Joe', 'Coffee @ 9am', 'Sydney at Night', 'AI-native ERP for Europe']) assert.equal(readsAsRole(r), false, r)
  assert.equal(readsAsRole('Head of Growth at Acme'), true)
})

test('review round 2 (haiku): an all-failed run is an outage, not "no posts"; title name shapes', async () => {
  const down = await linkedinPostCandidates(rc, plan(), { search: async () => { throw new Error('down') }, maxQueries: 3, maxResolve: 3 })
  assert.equal(down.ok, false); assert.equal(down.candidates.length, 0); assert.equal(down.searches.failed, down.searches.sent)
  const empty = await linkedinPostCandidates(rc, plan(), { search: async () => [], maxQueries: 3, maxResolve: 3 })
  assert.equal(empty.ok, true)
  const u = liPost('dana-okoye', '2026-10-01')
  assert.equal(authorOf({ url: u, title: 'Top 5 tips | Sales' })?.name, null, 'a one-word tail is not a name')
  assert.equal(authorOf({ url: u, title: 'Dana Okoye on LinkedIn - hi' })?.name, 'Dana Okoye')
})

test('review round 3 (sonnet): a handle\'s resolution applies to all its posts, whatever order the index returned them in', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  const co = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('acme', '2026-10-10', 'a'), 'Great news | LinkedIn'), mk(liPost('acme', '2026-10-11', 'b'), 'Acme Growth on LinkedIn: hiring')] : q.includes('acme') ? [mk('https://www.linkedin.com/company/acme', 'Acme Growth')] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(co.candidates.length, 0, 'the earlier unnamed post of a company handle is dropped too'); assert.equal(co.funnel.dropped['company page, not a person'], 2)
  const pe = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-10', 'a'), 'Big launch'), mk(liPost('dana-okoye', '2026-10-11', 'b'), "Dana Okoye's Post")] : q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoye - Founder at Okoye')] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(pe.authors[liPost('dana-okoye', '2026-10-10', 'a')].kind, 'person', 'the earlier unnamed post gets the resolved person too')
  assert.equal(pe.authors[liPost('dana-okoye', '2026-10-10', 'a')].name, 'Dana Okoye')
})

test('review round 3 (opus): a profile title with a credential after a comma still names the author', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  const r = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-11'), "Dana Okoye's Post")] : q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoye, CPA - Partner at Okoye LLP')] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(r.authors[liPost('dana-okoye', '2026-10-11')].kind, 'person')
  const r2 = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-11'), "Dana Okoye's Post")] : q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoyeson - Partner')] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(r2.authors[liPost('dana-okoye', '2026-10-11')].kind, 'unresolved', 'a longer name is another person')
})

test('review round 3 (haiku): prose is not a name and does not use up the lookup; a second name on a handle is not that person', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  assert.equal(authorOf({ url: liPost('dana-okoye', '2026-10-01'), title: 'Cold email tips on LinkedIn - part 2' })?.name, null)
  for (const n of ['Dana Okoye', 'Ludwig van Beethoven', 'Anne-Marie O\u2019Neil', 'José García']) assert.equal(nameShaped(n), true, n)
  for (const n of ['Cold email tips', 'Hiring now', 'LinkedIn', 'Sales', 'anand krishnakumar']) assert.equal(nameShaped(n), false, n)
  const r = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-10', 'a'), 'Cold email tips on LinkedIn - part 2'), mk(liPost('dana-okoye', '2026-10-11', 'b'), "Dana Okoye's Post"), mk(liPost('dana-okoye', '2026-10-12', 'c'), 'Random Other on LinkedIn: hello')] : q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoye - Founder at Okoye')] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(r.authors[liPost('dana-okoye', '2026-10-11', 'b')].kind, 'person', 'the prose-titled post did not use up the lookup')
  const other = r.authors[liPost('dana-okoye', '2026-10-12', 'c')]
  assert.equal(other.kind, 'unresolved'); assert.equal(other.profileUrl, null); assert.equal(other.name, 'Random Other')
  const longer = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-11'), "Dana Okoye's Post")] : q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoye Smith - Founder at Smith')] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(longer.authors[liPost('dana-okoye', '2026-10-11')].kind, 'unresolved')
  for (const role of ['Designer at Acme', 'Copywriter at Acme', 'Sales Development Representative at Acme']) assert.equal(readsAsRole(role), true, role)
})

test('review round 4 (opus + haiku): one lookup per (handle, name); credentials, pronouns and role phrases around a name', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  const prof = (q: string) => q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoye - Founder at Okoye')] : []
  for (const first of ['Cold Email Tips on LinkedIn - part 2', 'Random Other on LinkedIn: hello']) {
    const r = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-10', 'a'), first), mk(liPost('dana-okoye', '2026-10-11', 'b'), "Dana Okoye's Post")] : q.startsWith('site:') ? [] : prof(q), maxQueries: 2, maxResolve: 5 })
    assert.equal(r.authors[liPost('dana-okoye', '2026-10-11', 'b')].kind, 'person', first)
  }
  // the same name twice costs one lookup; a resolved handle is not looked up again
  const twice = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-10', 'a'), "Dana Okoye's Post"), mk(liPost('dana-okoye', '2026-10-11', 'b'), "Dana Okoye's Post")] : q.startsWith('site:') ? [] : prof(q), maxQueries: 2, maxResolve: 5 })
  assert.equal(twice.searches.sent, 3, 'two post queries + one lookup')
  // and when the lookup finds nothing, the same name is still not looked up a second time
  const miss = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('dana-okoye', '2026-10-10', 'a'), "Dana Okoye's Post"), mk(liPost('dana-okoye', '2026-10-11', 'b'), "Dana Okoye's Post")] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(miss.searches.sent, 3, 'two post queries + one lookup, even when nothing was found')
  const u = liPost('dana-okoye', '2026-10-01')
  assert.equal(authorOf({ url: u, title: 'Dana Okoye, CPA on LinkedIn: hi' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'Dana Okoye (She/Her) on LinkedIn: hi' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'Head Of Sales on LinkedIn: hi' })?.name, null)
  const base = { platform: 'linkedin' as const, handle: 'dana-okoye', name: 'Dana Okoye', profileUrl: 'https://www.linkedin.com/in/dana-okoye', kind: 'person' as const }
  assert.equal(authorPerson({ ...base, headline: 'Dana Okoye, CPA - Partner at Okoye LLP | x' })?.title, 'Partner at Okoye LLP')
})

test('review round 5 (haiku + opus): a company verdict is final; person-signal titles go first; at most 3 lookups per handle; name suffixes', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  // a handle decided as a company is never re-labelled a person by a later name
  const co = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [mk(liPost('acme-growth', '2026-10-10', 'a'), 'Acme Growth on LinkedIn: our launch'), mk(liPost('acme-growth', '2026-10-11', 'b'), "Jane Smith's Post")] : q.includes('Acme Growth') ? [mk('https://www.linkedin.com/company/acme-growth', 'Acme Growth')] : q.includes('Jane Smith') ? [mk('https://www.linkedin.com/in/acme-growth', 'Jane Smith - Founder at Acme Growth')] : [], maxQueries: 2, maxResolve: 5 })
  assert.equal(co.candidates.length, 0); assert.ok(!Object.values(co.authors).some(a => a.kind === 'person'))
  // company-titled posts on other handles do not use up the budget before a real author
  const many = Array.from({ length: 5 }, (_, i) => mk(liPost(`co${i}-corp`, `2026-10-0${i + 1}`), `Cold Email Tips on LinkedIn: n${i}`))
  const order = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [...many, mk(liPost('dana-okoye', '2026-10-09'), "Dana Okoye's Post")] : q.startsWith('site:') ? [] : q.includes('dana-okoye') ? [mk('https://www.linkedin.com/in/dana-okoye', 'Dana Okoye - Founder at Okoye')] : [], maxQueries: 2, maxResolve: 1 })
  assert.equal(order.authors[liPost('dana-okoye', '2026-10-09')].kind, 'person')
  // one handle with many names: at most 3 lookups
  const lots = Array.from({ length: 6 }, (_, i) => mk(liPost('busy', `2026-10-1${i}`, `p${i}`), `Topic ${['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'][i]} on LinkedIn: x`))
  const capped = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? lots : [], maxQueries: 2, maxResolve: 20 })
  assert.equal(capped.searches.sent, 2 + 3)
  for (const n of ['Chris Head', 'Jane Lead']) assert.equal(nameShaped(n), true, n)
  for (const n of ['Head Of Sales', 'Founder Stories', 'Growth at Acme']) assert.equal(nameShaped(n), false, n)
  const u = liPost('dana-okoye', '2026-10-01')
  assert.equal(authorOf({ url: u, title: 'Dana Okoye (She/Her), CPA on LinkedIn: hi' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'Dana Okoye, CPA, MBA on LinkedIn: hi' })?.name, 'Dana Okoye')
  assert.equal(authorOf({ url: u, title: 'Five Growth Tips, Revenue on LinkedIn: hi' })?.name, null, 'comma prose is not a credential')
})

test('review round 6 (haiku): a strong-signal name still gets looked up after three weak names; role phrases are not names', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  const posts = ['Alpha Bravo on LinkedIn: x', 'Charlie Delta on LinkedIn: x', 'Echo Foxtrot on LinkedIn: x'].map((t, i) => mk(liPost('busy', `2026-10-0${i + 1}`, `p${i}`), t))
  const r = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [...posts, mk(liPost('busy', '2026-10-09', 'd'), "Dana Okoye's Post")] : q.startsWith('site:') ? [] : q.includes('Dana Okoye') ? [mk('https://www.linkedin.com/in/busy', 'Dana Okoye - Founder at Okoye')] : [], maxQueries: 2, maxResolve: 20 })
  assert.equal(r.authors[liPost('busy', '2026-10-09', 'd')].kind, 'person')
  for (const n of ['Sales Director Secrets', 'Cold Email Lead Gen', 'Hiring Sales Manager Tips', 'Growth Of Outbound']) assert.equal(nameShaped(n), false, n)
  for (const n of ['Chris Head', 'Jane Lead']) assert.equal(nameShaped(n), true, n)
  assert.equal(authorOf({ url: liPost('five-tips', '2026-10-01'), title: 'Five Growth Tips, AI on LinkedIn: hi' })?.name, 'Five Growth Tips', 'known: an acronym after a comma is stripped; the lookup still needs the profile title to match')
})

test('known limits, pinned (council round 7): topic titles can take a handle\'s weak slots; a trailing role word passes the name shape', async () => {
  const mk = (url: string, title: string): IndexHit => ({ url, title, snippet: 's', date: null })
  const topics = ['Cold Email Tips on LinkedIn: x', 'Cold Email Tricks on LinkedIn: x', 'Outbound Tactics on LinkedIn: x'].map((t, i) => mk(liPost('busy', `2026-10-0${i + 1}`, `p${i}`), t))
  const prof = (q: string) => q.includes('Dana Okoye') ? [mk('https://www.linkedin.com/in/busy', 'Dana Okoye - Founder at Okoye')] : []
  const plain = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [...topics, mk(liPost('busy', '2026-10-09', 'd'), 'Dana Okoye on LinkedIn: hi')] : q.startsWith('site:') ? [] : prof(q), maxQueries: 2, maxResolve: 20 })
  assert.equal(plain.authors[liPost('busy', '2026-10-09', 'd')].kind, 'unresolved', 'known: a 4th plainly titled author after 3 topic titles is not looked up (fails closed)')
  const strongPost = await linkedinPostCandidates(rc, plan(), { search: async q => q.startsWith('site:linkedin.com/posts cold email agency') ? [...topics, mk(liPost('busy', '2026-10-09', 'd'), "Dana Okoye's Post")] : q.startsWith('site:') ? [] : prof(q), maxQueries: 2, maxResolve: 20 })
  assert.equal(strongPost.authors[liPost('busy', '2026-10-09', 'd')].kind, 'person', 'a strong signal is still looked up')
  for (const n of ['Growth Director', 'Sales Consultant']) assert.equal(nameShaped(n), true, `known: ${n} passes the shape (a lookup may be spent; a Person still needs the profile title to match)`)
})
