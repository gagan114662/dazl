// #878 (Hermes-PC re-audit 2026-11-12): every per-condition clause row a real staging scan wrote was "no evidence date"; the dental
// leads cite Instagram posts, and the post's own publish time never reached the lead. A public social post's own structured
// publish time, for exactly the post its URL names, now dates the claim its own text states (lib/scan/social-post.ts), through
// the existing binding rule. Fixtures are shaped like the real public pages (Instagram: the page instagram.com served to the
// scan's user agent on 2026-11-13, a server-rendered post with its embedded media record); invented companies, the socket is
// faked, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import Database from 'better-sqlite3'
import { socialPostRef, socialPostOf, socialPostBound, postDay } from '../lib/scan/social-post.ts'
import { fetchPageDetailed, isFail, resetBoardMemo, type Page } from '../lib/scan/fetch-page.ts'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { recordActionability } from '../lib/scan/actionable.ts'
import { evidenceRecheck } from '../lib/scan/evidence-recheck.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const CODE = 'DQx7Nw0kLmP', IG = `https://www.instagram.com/reel/${CODE}/`
const CAPTION = '🎉 Two locations now! 🎉\nNorthwind Dental opened a new location in Leslieville, our second clinic in Toronto.\n\n📍 Now open on Queen St E\n✨ Accepting new patients\n\n#NorthwindDental #Leslieville #NowOpen'
const QUOTE = 'Northwind Dental opened a new location in Leslieville, our second clinic in Toronto.'

// The server-rendered Instagram post page, as instagram.com served one to the scan's user agent: the title is just "Instagram",
// the caption and the visible day are in the body, and the post's own media record ("code", "taken_at", caption) is in the
// embedded script data next to the "more posts" grid (other shortcodes, no time).
function igPage(o: { code?: string; takenAt?: number | null; caption?: string; comments?: string[]; grid?: { code: string; takenAt?: number }[]; visible?: string } = {}): string {
  const code = o.code ?? CODE, caption = o.caption ?? CAPTION
  const record = o.takenAt === null ? `{"pk":"3789183126091260764","code":"${code}","media_type":2,"caption":{"pk":"18119035501793583","text":${JSON.stringify(caption)}}}`
    : `{"pk":"3789183126091260764","id":"3789183126091260764_59704675393","user":{"pk":"59704675393","username":"northwinddental","full_name":"Northwind Dental","is_private":false,"__typename":"User"},"__isXIGPolarisMedia":"XIGPolarisVideoMedia","code":"${code}","taken_at":${o.takenAt ?? at('2026-10-20T15:30:12Z')},"media_type":2,"product_type":"clips","coauthor_producers":[],"location":null,"clips_metadata":{"music_info":null,"original_sound_info":{"original_audio_title":"Original audio","ig_artist":{"username":"northwinddental","id":"59704675393"}}},"like_count":32,"comment_count":${(o.comments ?? []).length},"caption":{"pk":"18119035501793583","has_translation":null,"text":${JSON.stringify(caption)},"created_at":${(o.takenAt ?? at('2026-10-20T15:30:12Z')) + 454}}}`
  const grid = (o.grid ?? [{ code: 'DfrmZHtRDs5' }, { code: 'Dbq-JriJbjk' }]).map(g => `{"code":"${g.code}"${g.takenAt ? `,"taken_at":${g.takenAt}` : ''},"media_type":1,"like_count":4}`).join(',')
  const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html><html lang="en" class="_9dls"><head><meta charset="utf-8" /><title>Instagram</title>
<meta property="og:type" content="article" /><meta name="twitter:title" content="Northwind Dental (&#064;northwinddental) &#x2022; Instagram reel" />
<meta property="og:site_name" content="Instagram" /><meta property="og:url" content="https://www.instagram.com/northwinddental/reel/${code}/" />
<script type="application/json" data-sjs>{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"require":[["RelayPrefetchedStreamCache","next",[],["adp_PolarisPostRootQueryRelayPreloader",{"__bbox":{"complete":true,"result":{"data":{"xdt_api__v1__media__shortcode__web_info":{"items":[${record}]},"xdt_api__v1__discover__web__explore_grid":{"sections":[${grid}]}}}}}]]]}}]]]}</script>
</head><body><div id="mount_0_0_x"><div>Log In Sign Up Never miss a post from northwinddental Sign up for Instagram to stay in the loop. Sign up Log in</div>
<div><a href="/northwinddental/">northwinddental</a> • Follow Original audio</div><div><span>northwinddental</span> <span>Edited</span> • <time class="xdwrcjd" dateTime="2026-10-20T15:38:00.000Z" title="Oct 20, 2026">3w</time></div>
<h1 dir="auto">${html(caption).replace(/\n/g, '<br>')}</h1>${(o.comments ?? []).map(c => `<ul><li><span>happyclient</span> <span>${html(c)}</span> <time dateTime="2026-11-10T10:00:00.000Z">3d</time></li></ul>`).join('') || '<div>No comments yet. Start the conversation.</div>'}
<div>32</div>${o.visible ?? '<time class="x1p4m5qa" dateTime="2026-10-20T15:30:12.000Z" title="Oct 20, 2026">October 20, 2026</time>'}<div>Log in to like or comment.</div>
<div>More posts from northwinddental See more posts</div><footer>Meta About Blog Jobs Help API Privacy Terms Locations Popular Instagram Lite Meta AI Threads Contact Uploading &amp; Non-Users Meta Verified English © 2026 Instagram from Meta</footer></div></body></html>`
}
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const shell = (head: string, body = '') => `<!DOCTYPE html><html><head><title>Post</title>${head}</head><body>${body}</body></html>`

test('#878 social post URLs: exactly one post per URL; profiles, feeds, hashtags and search name none', () => {
  const yes: [string, string, string][] = [
    [IG, 'instagram', CODE], [`https://instagram.com/northwinddental/reel/${CODE}/?igsh=abc`, 'instagram', CODE], [`https://www.instagram.com/p/${CODE}`, 'instagram', CODE],
    ['https://www.facebook.com/northwinddental/posts/pfbid02AbCdEf123', 'facebook', 'pfbid02AbCdEf123'], ['https://m.facebook.com/permalink.php?story_fbid=1234567890&id=100064', 'facebook', '1234567890'], ['https://www.facebook.com/reel/1234567890123', 'facebook', '1234567890123'],
    ['https://www.linkedin.com/posts/northwind-dental_newclinic-activity-7254000000000000000-AbCd', 'linkedin', '7254000000000000000'], ['https://www.linkedin.com/feed/update/urn:li:activity:7254000000000000000/', 'linkedin', '7254000000000000000'],
    ['https://x.com/northwinddental/status/1849000000000000000', 'x', '1849000000000000000'], ['https://twitter.com/northwinddental/status/1849000000000000000/photo/1', 'x', '1849000000000000000'],
    ['https://www.tiktok.com/@northwinddental/video/7428000000000000000?lang=en', 'tiktok', '7428000000000000000'],
    ['https://www.youtube.com/watch?v=Ab3dEf9hIjK&t=10s', 'youtube', 'Ab3dEf9hIjK'], ['https://youtu.be/Ab3dEf9hIjK', 'youtube', 'Ab3dEf9hIjK'], ['https://www.youtube.com/shorts/Ab3dEf9hIjK', 'youtube', 'Ab3dEf9hIjK'],
  ]
  for (const [u, platform, id] of yes) assert.deepEqual(socialPostRef(u), { platform, id }, u)
  for (const no of ['https://www.instagram.com/northwinddental/', 'https://www.instagram.com/explore/tags/nowopen/', 'https://www.instagram.com/stories/northwinddental/3789183126091260764/',
    'https://www.facebook.com/northwinddental', 'https://www.facebook.com/northwinddental/posts/', 'https://www.linkedin.com/company/northwind-dental/posts/', 'https://www.linkedin.com/in/someone/recent-activity/all/',
    'https://x.com/northwinddental', 'https://x.com/search?q=northwind', 'https://www.tiktok.com/@northwinddental', 'https://www.youtube.com/@northwinddental', 'https://www.youtube.com/watch?v=short',
    'https://instagram.com.evil.example/p/DQx7Nw0kLmP/', 'https://northwinddental.example/reel/DQx7Nw0kLmP/', 'not a url']) assert.equal(socialPostRef(no), null, no)
})

test('#878 each platform: the post\'s own structured publish time for exactly this post URL is read, as a UTC day, with the post\'s own text', () => {
  // Instagram: the embedded media record (the shape instagram.com serves)
  const ig = socialPostOf(IG, IG, igPage(), NOW)
  assert.deepEqual(ig && [ig.platform, ig.id, ig.day], ['instagram', CODE, '2026-10-20'])
  assert.ok(ig!.texts.some(t => t.includes(QUOTE)), 'the caption is the post\'s own text')
  // YouTube: the VideoObject the watch page carries (@id with an escaped "=", uploadDate with an offset; a comment's dateCreated is not the video's)
  const YT = 'https://www.youtube.com/watch?v=Ab3dEf9hIjK'
  const ytHtml = shell(ld({ '@context': 'https://schema.org', '@type': 'VideoObject', '@id': YT, name: 'Northwind Dental opened a new location in Leslieville', thumbnailUrl: 'https://i.ytimg.com/vi/Ab3dEf9hIjK/maxresdefault.jpg', uploadDate: '2026-10-20T20:30:00-07:00', comment: [{ '@type': 'https://schema.org/Comment', dateCreated: '2026-11-01T10:00:00-07:00', text: 'Congrats!' }] }).replace('?v=', '?v\\u003d'))
  assert.deepEqual(socialPostOf(YT, YT, ytHtml, NOW)?.day, '2026-10-21', '20:30 at -07:00 is the next UTC day')
  // LinkedIn: the DiscussionForumPosting a public post page carries
  const LI = 'https://www.linkedin.com/posts/northwind-dental_newclinic-activity-7254000000000000000-AbCd'
  const li = socialPostOf(LI, LI, shell(ld({ '@context': 'http://schema.org', '@type': 'DiscussionForumPosting', '@id': LI, datePublished: '2026-10-20T15:30:00.000Z', dateModified: '2026-11-01T09:00:00.000Z', text: QUOTE, author: { '@type': 'Organization', name: 'Northwind Dental' }, comment: [{ '@type': 'Comment', text: 'Congrats!', datePublished: '2026-10-22T09:00:00.000Z' }] })), NOW)
  assert.deepEqual(li && [li.platform, li.day, li.texts], ['linkedin', '2026-10-20', [QUOTE]])
  // Facebook: a schema.org post entity naming exactly this post (the only shape read for Facebook)
  const FB = 'https://www.facebook.com/northwinddental/posts/pfbid02AbCdEf123'
  assert.equal(socialPostOf(FB, FB, shell(ld({ '@context': 'https://schema.org', '@type': 'SocialMediaPosting', url: FB, datePublished: '2026-10-20', articleBody: QUOTE })), NOW)?.day, '2026-10-20')
  // TikTok: the item record (id, desc, createTime as text); the author's own createTime is a nested object, never the video's
  const TT = 'https://www.tiktok.com/@northwinddental/video/7428000000000000000'
  const tt = socialPostOf(TT, TT, shell(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { id: '7428000000000000000', desc: QUOTE, author: { id: '6800000000000000000', uniqueId: 'northwinddental', createTime: at('2019-05-01T00:00:00Z') }, createTime: String(at('2026-10-20T15:30:00Z')), scheduleTime: 0 } } } } })}</script>`), NOW)
  assert.deepEqual(tt && [tt.day, tt.texts], ['2026-10-20', [QUOTE]])
  // X (a rendered page): the permalink's <time> for exactly this status id and the article's own tweetText (not the quoted post's)
  const XU = 'https://x.com/northwinddental/status/1849000000000000000'
  const xHtml = shell('', `<main><article role="article" data-testid="tweet"><div data-testid="User-Name"><a href="/northwinddental"><span>Northwind Dental</span></a></div><div lang="en" dir="auto" data-testid="tweetText"><span>${QUOTE}</span><div><span> Come say hi!</span></div></div><div role="link"><div data-testid="tweetText"><span>Another clinic opened somewhere else.</span></div><a href="/othercorp/status/1700000000000000000"><time datetime="2023-09-08T10:00:00.000Z">Sep 8, 2023</time></a></div><div><a href="/northwinddental/status/1849000000000000000" dir="ltr" aria-label="3:30 PM · Oct 20, 2026" role="link"><time datetime="2026-10-20T15:30:00.000Z">3:30 PM · Oct 20, 2026</time></a></div></article><article role="article" data-testid="tweet"><div data-testid="tweetText"><span>Congrats!</span></div><a href="/happyclient/status/1849500000000000000"><time datetime="2026-10-22T09:00:00.000Z">Oct 22</time></a></article></main>`)
  const x = socialPostOf(XU, XU, xHtml, NOW)
  assert.deepEqual(x && [x.day, x.texts], ['2026-10-20', [`${QUOTE} Come say hi!`]])
})

test('#878 a profile or feed page never dates a post, and another post\'s time is never this post\'s', () => {
  const grid = [{ code: 'DfrmZHtRDs5', takenAt: at('2026-11-12T10:00:00Z') }, { code: 'Dbq-JriJbjk', takenAt: at('2026-11-01T10:00:00Z') }]
  // the profile page lists its newest posts with their times: it names no post, so it dates nothing
  const PROFILE = 'https://www.instagram.com/northwinddental/'
  assert.equal(socialPostOf(PROFILE, PROFILE, igPage({ grid }), NOW), null)
  // a post page whose own record states no time, beside a grid of other posts that do: undated
  assert.equal(socialPostOf(IG, IG, igPage({ takenAt: null, grid }), NOW), null)
  // the grid's times never date this post when its own record does
  assert.equal(socialPostOf(IG, IG, igPage({ grid }), NOW)?.day, '2026-10-20')
  // a read that ended on another page (a login redirect, the profile, another post) dates nothing
  for (const fin of ['https://www.instagram.com/accounts/login/?next=%2Freel%2FDQx7Nw0kLmP%2F', PROFILE, 'https://www.instagram.com/reel/DfrmZHtRDs5/']) assert.equal(socialPostOf(IG, fin, igPage(), NOW), null, fin)
  // a company feed's posts (LinkedIn) and a post page that carries only ANOTHER post's entity
  const FEED = 'https://www.linkedin.com/company/northwind-dental/posts/'
  const other = { '@context': 'http://schema.org', '@type': 'DiscussionForumPosting', '@id': 'https://www.linkedin.com/posts/northwind-dental_old-activity-7100000000000000000-XyZw', datePublished: '2026-11-12T08:00:00Z', text: QUOTE }
  assert.equal(socialPostOf(FEED, FEED, shell(ld({ '@type': 'ItemList', itemListElement: [other] }) + ld(other)), NOW), null)
  const LI = 'https://www.linkedin.com/posts/northwind-dental_newclinic-activity-7254000000000000000-AbCd'
  assert.equal(socialPostOf(LI, LI, shell(ld(other)), NOW), null)
  // X: the reply's and the quoted post's times are other statuses; a profile timeline names no post
  const XU = 'https://x.com/northwinddental/status/1849000000000000000'
  assert.equal(socialPostOf(XU, XU, shell('', '<article><div data-testid="tweetText">x</div><a href="/happyclient/status/1849500000000000000"><time datetime="2026-10-22T09:00:00.000Z">Oct 22</time></a></article>'), NOW), null)
  assert.equal(socialPostOf('https://x.com/northwinddental', 'https://x.com/northwinddental', shell('', '<article><a href="/northwinddental/status/1849000000000000000"><time datetime="2026-10-20T15:30:00.000Z">Oct 20</time></a></article>'), NOW), null)
  // two different days stated for the same post: no day
  const two = igPage().replace('</head>', `${ld({ '@type': 'VideoObject', '@id': IG, uploadDate: '2026-10-25T10:00:00Z' })}</head>`)
  assert.equal(socialPostOf(IG, IG, two, NOW), null)
})

test('#878 "3 days ago" text, a bare <time>, a modified time and the retrieval time never date a post', () => {
  const U = 'https://www.facebook.com/northwinddental/posts/pfbid02AbCdEf123'
  const textOnly = shell('<meta property="og:description" content="Northwind Dental · 3 days ago · Northwind Dental opened a new location in Leslieville" />', `<div>Northwind Dental</div><span>3 days ago</span><span>3d</span><span>47w</span><time datetime="2026-11-10T10:00:00Z">3d</time><p>${QUOTE}</p>`)
  assert.equal(socialPostOf(U, U, textOnly, NOW), null)
  assert.equal(socialPostOf(U, U, shell(ld({ '@type': 'SocialMediaPosting', url: U, dateModified: '2026-11-10T10:00:00Z', articleBody: QUOTE })), NOW), null, 'a modified time is not a publish time')
  // an Instagram page without the post's record, only its visible text ("3w", "October 20, 2026"): undated
  assert.equal(socialPostOf(IG, IG, igPage().replace(/"code":"DQx7Nw0kLmP","taken_at":\d+,/, ''), NOW), null)
  // the post's own text dating its event relative to another time is not dated by the post's time
  const rel = socialPostOf(IG, IG, igPage({ caption: 'Northwind Dental opened a new location in Leslieville 3 weeks ago, our second clinic in Toronto.' }), NOW)
  assert.equal(rel?.day, '2026-10-20')
  assert.equal(socialPostBound(rel, 'Northwind Dental opened a new location in Leslieville 3 weeks ago', 'Northwind Dental').bound, false)
  const tbt = socialPostOf(IG, IG, igPage({ caption: `#throwback ${QUOTE}` }), NOW)
  assert.equal(socialPostBound(tbt, QUOTE, 'Northwind Dental').bound, false)
})

test('#878 the date contract: a future day, a day before 2000 and a malformed time are refused', () => {
  assert.equal(postDay(at('2026-11-13T23:59:00Z'), NOW), '2026-11-13', 'today (UTC) is a day')
  assert.equal(postDay(at('2026-11-14T00:00:01Z'), NOW), null, 'tomorrow is the future')
  assert.equal(postDay('2027-01-01T00:00:00Z', NOW), null)
  assert.equal(postDay(at('1999-12-31T12:00:00Z'), NOW), null)
  for (const bad of ['2026-02-30', 'Oct 20, 2026', '3 days ago', '', null, {}, -5, 1.5, 'NaN']) assert.equal(postDay(bad, NOW), null, String(bad))
  assert.equal(socialPostOf(IG, IG, igPage({ takenAt: at('2026-12-01T00:00:00Z') }), NOW), null, 'a future post time is no day')
  assert.equal(socialPostOf(IG, IG, igPage({ takenAt: at('1998-06-01T00:00:00Z') }), NOW), null)
})

test('#878 binding: the post\'s day dates only a quote from the post\'s own text that the binding rule ties to this company and event', () => {
  const post = socialPostOf(IG, IG, igPage(), NOW)
  const ok = socialPostBound(post, QUOTE, 'Northwind Dental')
  assert.equal(ok.bound, true, ok.why); assert.match(ok.why, /instagram post's own structured publish time for exactly this post URL/)
  assert.equal(socialPostBound(post, `...${QUOTE.slice(0, 60)}...`, 'Northwind Dental').bound, true, 'a cut quote')
  // a comment under the post is not the post's text
  assert.equal(socialPostBound(post, 'Congrats Northwind Dental on opening the new Leslieville location!', 'Northwind Dental').bound, false)
  // another company's event in the post's text (the company only as a possessive in front of it) is not dated as this company's
  const other = socialPostOf(IG, IG, igPage({ caption: "Northwind Dental's landlord Acme Realty opened a new location in Leslieville, its second in Toronto." }), NOW)
  assert.equal(socialPostBound(other, "Northwind Dental's landlord Acme Realty opened a new location in Leslieville", 'Northwind Dental').bound, false)
  // the quote names an earlier year than the post
  const old = socialPostOf(IG, IG, igPage({ caption: 'Northwind Dental opened a new location in Leslieville in 2019, our second clinic in Toronto.' }), NOW)
  assert.equal(socialPostBound(old, 'Northwind Dental opened a new location in Leslieville in 2019', 'Northwind Dental').bound, false)
  // a future plan in the post
  const plan = socialPostOf(IG, IG, igPage({ caption: 'Northwind Dental will open a new location in Leslieville, our second clinic in Toronto.' }), NOW)
  assert.equal(socialPostBound(plan, 'Northwind Dental will open a new location in Leslieville', 'Northwind Dental').bound, false)
  assert.equal(socialPostBound(null, QUOTE, 'Northwind Dental').bound, false)
})

// ---- through the scan path: the real page fetcher (socket faked), the verifier, the real clause writer, the recheck
function fakeHttps(serve: (url: string) => { status: number; type: string; body: string }) {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => {
      const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} })
      cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end')
    }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}
const UNDATED = 'https://www.instagram.com/p/DUndAtEd001/'
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
const serveIg = (takenAt: number) => (u: string) =>
  u === IG ? { status: 200, type: 'text/html; charset="utf-8"', body: igPage({ takenAt }) }
  : u === UNDATED ? { status: 200, type: 'text/html; charset="utf-8"', body: igPage({ code: 'DUndAtEd001', takenAt: null, caption: CAPTION.replace(/Northwind/g, 'Southside') }) }
  : { status: 404, type: 'text/html', body: '' }
const draft = (over: Partial<LeadDraft> = {}) => ({ name: '', company: 'Northwind Dental', contact: null, signal: 'Opened a new location in Leslieville', source_url: IG, excerpt: QUOTE, event_date: null, score: 80, ...over }) as LeadDraft
const read = (u: string) => fetchPageDetailed(u, async () => null)

test('#878 the verifier dates an Instagram-cited opening by the post\'s own publish time (page_bound), and keeps every date rule', async () => {
  const restore = fakeHttps(serveIg(at('2026-10-20T15:30:12Z')))
  try {
    const page = await read(IG)
    assert.ok(!isFail(page), JSON.stringify(page))
    assert.deepEqual((page as Page).post && [(page as Page).post!.platform, (page as Page).post!.day], ['instagram', '2026-10-20'])
    assert.equal((page as Page).published ?? null, null, 'the post time is not a page publication label')
    for (const event_date of [null, '2026-10-20', '2026-10-01']) {
      const o = await verifyLeads([draft({ event_date })], read, new Date(NOW))
      assert.equal(o.leads.length, 1, JSON.stringify(o))
      assert.deepEqual([o.leads[0].event_date, o.leads[0].event_date_proof], ['2026-10-20', 'page_bound'], `claimed ${event_date}`)
      assert.match(o.leads[0].event_date_proof_note ?? '', /instagram post's own structured publish time/)
    }
    // a claimed day the date rules reject keeps its hold: never replaced by the post's fresh day
    const stale = await verifyLeads([draft({ event_date: '2019-03-01' })], read, new Date(NOW))
    assert.deepEqual([stale.leads.length, stale.review.map(r => r.review_reason)], [0, ['event_date_stale']])
    // a quote from a comment (not the post's own text) stays undated
    const restore2 = fakeHttps(() => ({ status: 200, type: 'text/html', body: igPage({ comments: ['Northwind Dental opened a new location in Leslieville, so happy for you!'] }) }))
    try {
      const c = await verifyLeads([draft({ excerpt: 'Northwind Dental opened a new location in Leslieville, so happy for you!' })], read, new Date(NOW))
      assert.deepEqual([...c.leads, ...c.review].map(l => [l.event_date, l.event_date_proof ?? null]), [[null, null]])
    } finally { restore2() }
  } finally { restore() }
  // an old post is dated by its own day and judged by the date rules like any day: older than the age limit, held stale
  const restore3 = fakeHttps(serveIg(at('2025-06-01T12:00:00Z')))
  try {
    const old = await verifyLeads([draft()], read, new Date(NOW))
    assert.deepEqual([old.leads.length, old.review.map(r => [r.review_reason, r.event_date])], [0, [['event_date_stale', '2025-06-01']]])
  } finally { restore3() }
})

test('#878 end to end: an Instagram-cited opening lead gets the clause row "evidence dated <day>" with its own source URL; an undated post keeps "no evidence date"', async () => {
  const posted = day(20)
  const restore = fakeHttps(serveIg(at(`${posted}T15:30:12Z`)))
  try {
    // two Instagram-cited openings: one post whose page states its own publish time, one whose page states none
    const v = await verifyLeads([draft(), draft({ company: 'Southside Dental', source_url: UNDATED, excerpt: QUOTE.replace('Northwind', 'Southside') })], read)
    assert.equal(v.leads.length, 2, JSON.stringify(v))
    const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
    db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)'); db.prepare('INSERT INTO users VALUES(?,?,?)').run('u1', 'Dental practice software', '')
    const query = 'Dental clinics in Toronto that opened a new location in the last 90 days or are hiring front-desk staff' // a staging dental play's shape
    const icp = JSON.stringify({ summary: 'Toronto dental clinics', who: ['Owner'], industries: ['dental'], sizes: [], where: ['Toronto'], signals: ['opened a new location'], exclude: [], window_days: 90 })
    const jobId = createQueryJob(db, 'u1', { query })
    db.prepare("UPDATE scan_jobs SET status = 'running', icp = ?, offer = ? WHERE id = ?").run(icp, 'Dental practice software', jobId)
    const lead = v.leads.find(l => l.source_url === IG)!, none = v.leads.find(l => l.source_url === UNDATED)!
    assert.deepEqual([lead.event_date, lead.event_date_proof], [posted, 'page_bound'])
    assert.deepEqual([none.event_date, none.event_date_proof ?? null], [null, null])
    // stored as the runner stores a verified lead (its columns), then the real clause writer
    const ins = db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date, date_status, event_date_proof, event_date_proof_note, confidence, score, fit) VALUES (?, ?, '', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 80, 5)")
    for (const [id, l] of [['dated', lead], ['undated', none]] as const) ins.run(id, jobId, l.company, l.signal, l.source_url, l.excerpt, l.event_date, l.date_status, l.event_date_proof ?? null, l.event_date_proof_note ?? null, l.confidence)
    recordActionability(db, { id: jobId, user_id: 'u1', query, icp })
    const rows = (id: string) => db.prepare("SELECT value, source_url, source_date FROM lead_enrichments WHERE lead_id = ? AND tenant_id = 'u1' AND connector = 'scan:targeting' ORDER BY value").all(id) as { value: string; source_url: string; source_date: string }[]
    const dated = rows('dated'), und = rows('undated')
    assert.deepEqual(dated[0], { value: `C1 opened a new location in the last 90 days: pass, evidence dated ${posted}`, source_url: IG, source_date: posted })
    assert.match(dated[1].value, /^C2 hiring front-desk staff: unknown, no evidence date$/, 'the other condition keeps its own (missing) evidence')
    assert.equal(und.length, 2)
    assert.match(und[0].value, /^C1 opened a new location in the last 90 days: unknown, no evidence date$/)
    assert.equal(und[0].source_url, UNDATED)
    // the read-only recheck gives the saved dated lead the verifier's proof (it said "not tied to this company and event" before)
    const r = await evidenceRecheck(db, 'u1', 'dated', undefined, new Date())
    assert.equal(r?.status, 'checked', JSON.stringify(r))
    const c = r!.checks as { event_date_bound: boolean; event_date_proof: string | null; window: string }
    assert.deepEqual([c.event_date_bound, c.event_date_proof, c.window], [true, 'page_bound', 'inside'], JSON.stringify(r))
    assert.doesNotMatch(r!.reasons.join(' '), /not tied to this company and event/)
  } finally { restore() }
})

// ---- review at ad04c841 (CHANGES): the post's day must never date a statement that carries its own time, or another party's post
const TIMED: string[] = [
  'Northwind Dental opened a new location in Leslieville in March 2025, our second clinic.',
  'Northwind Dental opened a new location in Leslieville in 2025, our second clinic.',
  'Northwind Dental opened a new location in Leslieville on October 1, our second clinic.',
  'Northwind Dental opened a new location in Leslieville last Friday, our second clinic.',
  'Northwind Dental grand opening of our Leslieville location this Saturday, October 25!',
  'Northwind Dental is opening a new location in Leslieville on Saturday.',
  'Northwind Dental opens a new location in Leslieville in December, our second clinic.',
  'Northwind Dental has been open in Leslieville for five years, thanks to all our patients.',
  'Northwind Dental opened a new location in Leslieville in spring 2024, our second clinic.',
  'Northwind Dental opened its first location in Leslieville in 2019 and its second today.',
  'Northwind Dental opened a new location in Leslieville yesterday, our second clinic.',
  'Northwind Dental recently opened a new location in Leslieville, our second clinic.',
]
const quoteOf = (caption: string) => caption.replace(/[!.]$/, '')
// a time stated anywhere in the quote's own sentence counts, even when the quote is cut before it
const CUT = { caption: 'Northwind Dental opened a new location in Leslieville on October 1, our second clinic.', quote: 'Northwind Dental opened a new location in Leslieville' }

test('#878 review R1: a quote, or the post sentence that carries it, stating its own time (or none we can read) never takes the post day', () => {
  for (const caption of TIMED) {
    const post = socialPostOf(IG, IG, igPage({ caption }), NOW)
    assert.equal(post?.day, '2026-10-20', caption)
    const r = socialPostBound(post, quoteOf(caption), 'Northwind Dental')
    assert.equal(r.bound, false, `${caption}: ${r.why}`)
  }
  const cut = socialPostOf(IG, IG, igPage({ caption: CUT.caption }), NOW)
  assert.equal(socialPostBound(cut, CUT.quote, 'Northwind Dental').bound, false, 'the date sits in the same sentence, after the cut quote')
  // a time in ANOTHER sentence of the caption does not stop the quote's own sentence from being dated by the post
  const other = socialPostOf(IG, IG, igPage({ caption: `${QUOTE}\nOpen Monday to Saturday, 9am to 6pm.` }), NOW)
  assert.equal(socialPostBound(other, QUOTE, 'Northwind Dental').bound, true)
})

test('#878 review R1/R2: through the verifier (claimed day none), every timed quote ends undated or held, never page_bound with the post day; a quote\'s own day wins', async () => {
  for (const caption of [...TIMED, CUT.caption]) {
    const restore = fakeHttps(() => ({ status: 200, type: 'text/html; charset="utf-8"', body: igPage({ caption, takenAt: at('2026-10-20T15:30:12Z') }) }))
    try {
      const quote = caption === CUT.caption ? CUT.quote : quoteOf(caption)
      const o = await verifyLeads([draft({ excerpt: quote })], read, new Date(NOW))
      const all = [...o.leads, ...o.review]
      assert.ok(all.length >= 1, caption)
      for (const l of all) assert.ok(l.event_date !== '2026-10-20' && l.event_date_proof !== 'page_bound', `${caption}: ${JSON.stringify([l.event_date, l.event_date_proof, (l as { review_reason?: string }).review_reason])}`)
    } finally { restore() }
  }
  // R2: a quote naming its own day keeps that day (the text binding), never the post's
  const DAYED = 'Northwind Dental opened a new location in Leslieville on October 1, 2026, our second clinic.'
  const restore = fakeHttps(() => ({ status: 200, type: 'text/html; charset="utf-8"', body: igPage({ caption: DAYED }) }))
  try {
    const own = await verifyLeads([draft({ excerpt: quoteOf(DAYED), event_date: '2026-10-01' })], read, new Date(NOW))
    assert.deepEqual(own.leads.map(l => [l.event_date, l.event_date_proof]), [['2026-10-01', 'page_bound']])
    assert.doesNotMatch(own.leads[0].event_date_proof_note ?? '', /post's own structured publish time/)
    const none = await verifyLeads([draft({ excerpt: quoteOf(DAYED) })], read, new Date(NOW))
    assert.deepEqual(none.leads.map(l => [l.event_date, l.event_date_proof ?? null]), [[null, null]])
  } finally { restore() }
})

test('#878 review R5: another party\'s post about the company (congratulations, "our friends at") is not dated by the post', () => {
  for (const caption of ['Congrats to our friends at Northwind Dental, who opened a new location in Leslieville!', 'Huge shout-out to Northwind Dental, who opened a new location in Leslieville.', 'We designed the space for our friends at Northwind Dental, who opened a new location in Leslieville.']) {
    const post = socialPostOf(IG, IG, igPage({ caption }), NOW)
    assert.equal(socialPostBound(post, quoteOf(caption), 'Northwind Dental').bound, false, caption)
  }
  // the company's own post that also thanks someone is still its own
  const own = socialPostOf(IG, IG, igPage({ caption: 'Northwind Dental opened a new location in Leslieville, thanks to our amazing team!' }), NOW)
  assert.equal(socialPostBound(own, 'Northwind Dental opened a new location in Leslieville, thanks to our amazing team', 'Northwind Dental').bound, true)
})

// ---- review round 2 at 8e38655d: an ALLOW-LIST, not a blocklist. Every caption below leaked through the round-1 word list.
const LEAKED: string[] = [
  'Northwind Dental is set to open a new location in Leslieville, our second clinic.',
  'Northwind Dental is about to open a new location in Leslieville, our second clinic.',
  'Northwind Dental is launching a new location in Leslieville, our second clinic.',
  'Northwind Dental is expanding into a new location in Leslieville, our second clinic.',
  'Northwind Dental new location in Leslieville is under construction, stay tuned.',
  'Northwind Dental opened a new location in Leslieville on 10/25, our second clinic.',
  'Northwind Dental opened a new location in Leslieville on the 25th, our second clinic.',
  'Northwind Dental opened a new location in Leslieville in Q3, our second clinic.',
  'Northwind Dental opened a new location in Leslieville in the 90s, our second clinic.',
  'Northwind Dental opened a new location in Leslieville the other day, our second clinic.',
  'Northwind Dental opened a new location in Leslieville over the holidays, our second clinic.',
  'Northwind Dental opened a new location in Leslieville before Christmas, our second clinic.',
  'Northwind Dental opened a new location in Leslieville on Canada Day, our second clinic.',
  'Northwind Dental has served Leslieville after 10 years downtown, our second clinic.',
  'Northwind Dental abrió una nueva clínica en Leslieville la semana pasada.',
  'Northwind Dental ouvre une nouvelle clinique à Leslieville bientôt.',
  'Northwind Dental eröffnet nächste Woche eine neue Praxis in Leslieville.',
]
// R6: these in ANOTHER sentence of the caption never block the quote's own sentence
const OTHER_SENTENCES = ['Visit us at 2050 Queen St E.', 'Most insurance plans accepted.', 'Right next to the Loblaws.', 'Find us on Spring Garden Road.', 'You will love our team!', 'Open late Mondays.']
// R5 nit: a greeting before the company's name, and ":" ending a sentence
const R5_DATED = ['Welcome to Northwind Dental Parkdale, our second clinic, now open for patients.', 'Huge thanks to our team: Northwind Dental opened a new location in Parkdale.']

test('#878 review round 2: captions that leaked through the word list are undated, through socialPostBound and the verifier (claimed day none)', async () => {
  for (const caption of LEAKED) {
    const post = socialPostOf(IG, IG, igPage({ caption }), NOW)
    assert.equal(post?.day, '2026-10-20', caption)
    const r = socialPostBound(post, quoteOf(caption), 'Northwind Dental')
    assert.equal(r.bound, false, `${caption}: ${r.why}`)
    const restore = fakeHttps(() => ({ status: 200, type: 'text/html; charset="utf-8"', body: igPage({ caption }) }))
    try {
      const o = await verifyLeads([draft({ excerpt: quoteOf(caption) })], read, new Date(NOW))
      const all = [...o.leads, ...o.review]
      for (const l of all) assert.ok(l.event_date !== '2026-10-20' && l.event_date_proof !== 'page_bound', `${caption}: ${JSON.stringify([l.event_date, l.event_date_proof])}`)
    } finally { restore() }
  }
})

test('#878 review round 2 (R6, R5): other sentences never block; a greeting or ":" before the company still dates its completed opening', async () => {
  for (const other of OTHER_SENTENCES) {
    const caption = `${QUOTE}\n${other}`
    const post = socialPostOf(IG, IG, igPage({ caption }), NOW)
    const r = socialPostBound(post, QUOTE, 'Northwind Dental')
    assert.equal(r.bound, true, `${other}: ${r.why}`)
  }
  // the same through the verifier, all six other sentences in one caption
  const restore = fakeHttps(() => ({ status: 200, type: 'text/html; charset="utf-8"', body: igPage({ caption: [QUOTE, ...OTHER_SENTENCES].join('\n') }) }))
  try {
    const o = await verifyLeads([draft()], read, new Date(NOW))
    assert.deepEqual(o.leads.map(l => [l.event_date, l.event_date_proof]), [['2026-10-20', 'page_bound']])
  } finally { restore() }
  for (const caption of R5_DATED) {
    const post = socialPostOf(IG, IG, igPage({ caption }), NOW)
    const r = socialPostBound(post, quoteOf(caption), 'Northwind Dental')
    assert.equal(r.bound, true, `${caption}: ${r.why}`)
  }
  // a street address in the quote's own sentence is a place, not a time
  const addr = socialPostOf(IG, IG, igPage({ caption: 'Northwind Dental opened a new location at 2050 Queen St E, our second clinic.' }), NOW)
  assert.equal(socialPostBound(addr, 'Northwind Dental opened a new location at 2050 Queen St E, our second clinic', 'Northwind Dental').bound, true)
})

test('#878 review round 2 (a): only a completed event of the kind the claim needs, from the fixed English wording', () => {
  const hiring = socialPostOf(IG, IG, igPage({ caption: "Northwind Dental is hiring a front desk coordinator for our Leslieville clinic, apply in the link in bio." }), NOW)
  const q = 'Northwind Dental is hiring a front desk coordinator for our Leslieville clinic'
  assert.equal(socialPostBound(hiring, q, 'Northwind Dental', 'hiring').bound, true)
  assert.equal(socialPostBound(hiring, q, 'Northwind Dental', 'event').bound, false, 'hiring wording does not date an opening claim')
  assert.equal(socialPostBound(socialPostOf(IG, IG, igPage(), NOW), QUOTE, 'Northwind Dental', 'hiring').bound, false, 'opening wording does not date a hiring claim')
  for (const caption of ['Grand opening of our new clinic: Northwind Dental in Parkdale welcomes patients.', 'Come visit Northwind Dental at our new clinic in Parkdale, now accepting new patients.']) {
    assert.equal(socialPostBound(socialPostOf(IG, IG, igPage({ caption }), NOW), quoteOf(caption), 'Northwind Dental').bound, false, `acknowledged loss: ${caption}`)
  }
})
