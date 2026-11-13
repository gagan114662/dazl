// #767 live check (Hermes-PC, staging at 194e9ada): a careers lead from a public Ashby posting was held as quote_unconfirmed. The quote was built across
// `${title} ${description}` ("Sales Assist Representative AI AT ZAPIER At Zapier ...": the title glued onto the description's boilerplate preamble), a string that is on
// no page. These fixtures are real-shaped (the Ashby / Lever public API records, a descriptionPlain that opens with a company preamble, modelled on the live
// Zapier "Sales Assist Representative" posting) for an invented company, Brightloop. The verifier's page is the REAL rendering of the same board record
// (atsRecord + atsPageText, lib/sources/ats-posting.ts); no network, no model. Local fixture, not live proof.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { careersSalesVacancy, postingQuote } from '../lib/signals/careers-page.ts'
import { atsPageText, atsPostingRef, atsRecord } from '../lib/sources/ats-posting.ts'
import * as fetchPage from '../lib/scan/fetch-page.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const master = randomBytes(32)
const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const POSTED = ago(9)
const ID = '6adee270-03bf-4b1b-915b-eba5fb56d1b6'
const ASHBY = `https://jobs.ashbyhq.com/brightloop/${ID}`
const LEVER_ID = '3f1c2b9a-7d4e-4c1a-9b2f-5e6d7c8b9a01'
const LEVER = `https://jobs.lever.co/brightloop/${LEVER_ID}`
const PREAMBLE = 'AI AT BRIGHTLOOP\n\nAt Brightloop https://brightloop.io/about, we build and use automation every day to make work more efficient, creative, and human. So if you’re using AI tools while applying here - that’s great! We just ask that you use them responsibly and transparently.\n\nCheck out our guidance on How to Collaborate with AI During Brightloop’s Hiring Process https://brightloop.io/l/jobs/ai-at-brightloop, including how to use AI tools during our hiring process - and when not to.\n\n \n\nAI Fluency Assessment https://ai-fluency.example\nTake our 10 minute AI Fluency Assessment by clicking the link above. See how your skills stack up against our sales bar.\n\n\n\nJob Posted: June 2026\n\nLocation: India\n\n\n\n'
const ROLE = 'Hi there!\n\nWe’re looking for a new Sales-Assist Representative to join the Sales-Assist Motion at Brightloop.\n\nBrightloop’s on a mission to make everyone more productive at work. The Sales Assist group serves customers as they evaluate and buy Brightloop’s offers, through a high-velocity sales motion.\n\nABOUT YOU\n\n - You are located in India and able to work within the hours of ~9:00 pm - 7:00 am IST.'
const ASHBY_DESC = PREAMBLE + ROLE
const LEVER_DESC = 'About Brightloop\nBrightloop builds workflow software for finance teams. Our customers include hundreds of mid-market companies across Europe, and we are backed by leading investors.\n\nThe opportunity\nWe are hiring an Account Executive to own the full sales cycle for new mid-market customers in London, from first call to signed contract.'
const LEVER_PREAMBLE = 'About Brightloop\nBrightloop builds workflow software for finance teams. Our customers include hundreds of mid-market companies across Europe, and we are backed by leading investors.\n\nBenefits\nPrivate health cover, a learning budget and 30 days of holiday.'
const ashbyBoard = (desc: string) => JSON.stringify({ jobs: [{ id: ID, title: 'Sales Assist Representative', location: 'APAC', isListed: true, publishedAt: `${POSTED}T21:00:14.036+00:00`, jobUrl: ASHBY, descriptionPlain: desc, descriptionHtml: `<p>${desc}</p>` }] })
const leverRecord = (desc: string) => JSON.stringify({ id: LEVER_ID, text: 'Account Executive', descriptionPlain: desc, description: `<div>${desc}</div>`, additionalPlain: 'Brightloop is an equal opportunity employer.', categories: { location: 'London' }, createdAt: Date.parse(`${POSTED}T09:00:00Z`) })
const GH = 'https://boards.greenhouse.io/brightloop/jobs/4012345'
// Greenhouse sends content as escaped HTML and the record also carries company_name: the old text was `${title} ${company_name} ${content}`
const GH_DESC = '<h2>About Brightloop</h2><p>Brightloop builds workflow software for finance teams across Europe &amp; the UK.</p><h2>The role</h2><p>We are hiring an Account Executive to own the full sales cycle for new mid-market customers in London.</p>'
const GH_PREAMBLE = '<h2>About Brightloop</h2><p>Brightloop builds workflow software for finance teams across Europe &amp; the UK.</p><h2>Benefits</h2><p>Private health cover and 30 days of holiday.</p>'
const ghRecord = (desc: string) => JSON.stringify({ id: 4012345, title: 'Account Executive', company_name: 'Brightloop', first_published: `${POSTED}T09:00:00Z`, location: { name: 'London' }, content: desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') })
const html = (b: string) => `<html><body>${b}</body></html>`
type Board = 'ashby' | 'lever' | 'greenhouse'
const http = (board: Board, desc: string): SafeGet => async url => {
  const u = new URL(url)
  if (u.hostname === 'hn.algolia.com') return null
  if (u.hostname === 'api.ashbyhq.com') return { status: 200, body: ashbyBoard(desc) }
  if (u.hostname === 'api.lever.co') return { status: 200, body: leverRecord(desc) }
  if (u.hostname === 'boards-api.greenhouse.io') return { status: 200, body: ghRecord(desc) }
  if (u.hostname === 'brightloop.io' && u.pathname === '/careers') return { status: 200, body: html(board === 'ashby' ? `<ul><li><a href="${ASHBY}">Sales Assist Representative</a></li></ul>` : `<ul><li><a href="${board === 'lever' ? LEVER : GH}">Account Executive</a></li></ul>`) }
  return { status: 404, body: '' }
}
const get = (board: Board, desc: string) => async (url: string) => { const r = await http(board, desc)(url); return r ? { ...r, finalUrl: url } : null }
// the verifier's page: the board record rendered exactly as lib/scan/fetch-page.ts renders it (title line, then the posting's own text), dated by postedAt
const verifierPage = (board: Board, desc: string) => async (url: string) => {
  const ref = atsPostingRef(url); if (!ref) return { fail: 'error' }
  const rec = atsRecord(JSON.parse(board === 'ashby' ? ashbyBoard(desc) : board === 'lever' ? leverRecord(desc) : ghRecord(desc)), ref)
  if (!rec || rec === 'missing') return { fail: 'not_found' }
  const p = atsPageText(rec, rec.html ? ghText(rec.description) : rec.description)
  return { text: p.text, title: p.title, retrievedAt: Math.floor(Date.now() / 1000), published: rec.posted, postedAt: rec.posted, structured: [] }
}
// the Greenhouse content as the verifier reads it: lib/scan/fetch-page.ts's own htmlToText(decode(content)), never a hand-written copy. (Before #767 decode was
// not exported; the fallback is a verbatim copy of it, used only then, so each test here fails for its own reason against an older careers-page.ts.)
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decodeCopy = (x: string) => x.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, e: string) => { if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' ' } return ENT[e.toLowerCase()] ?? ' ' })
const decode: (x: string) => string = (fetchPage as { decode?: (x: string) => string }).decode ?? decodeCopy
const ghText = (escaped: string) => fetchPage.htmlToText(decode(escaped)).text
const NOW = Date.now()
const vacancy = (board: Board, desc: string) => careersSalesVacancy('brightloop.io', get(board, desc), { now: NOW, company: 'Brightloop', namedQuote: true })
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

test('Ashby: the quote is a verbatim passage of descriptionPlain that states the vacancy, never the title glued onto the preamble', async () => {
  const r = await vacancy('ashby', ASHBY_DESC)
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  assert.ok(q.length >= 20 && q.length <= 300, q)
  assert.ok(flat(ASHBY_DESC).includes(q), `the quote is a verbatim substring of descriptionPlain: ${q}`)
  assert.ok(!q.startsWith('Sales Assist Representative AI AT'), 'never across the title / description join')
  assert.ok(!/AI AT BRIGHTLOOP|automation every day|Hiring Process/i.test(q), `not the boilerplate preamble: ${q}`)
  assert.match(q, /looking for a new Sales-Assist Representative/, 'the sentence naming the role')
})
test('Ashby: a preamble-only descriptionPlain (it never names the role or the hiring) gives no quote', async () => {
  const r = await vacancy('ashby', PREAMBLE + 'ABOUT YOU\n\n - You are located in India.')
  assert.equal(r.reason, 'found'); assert.equal(r.vacancy!.quote, '', `no quote: ${r.vacancy!.quote}`)
})
test('Lever: the quote is a verbatim passage of descriptionPlain stating the hiring; a preamble-only posting gives no quote', async () => {
  const r = await vacancy('lever', LEVER_DESC)
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  assert.ok(flat(LEVER_DESC).includes(q), `the quote is a verbatim substring of descriptionPlain: ${q}`)
  assert.ok(!q.startsWith('Account Executive About'), 'never across the title / description join')
  assert.match(q, /We are hiring an Account Executive/)
  const none = await vacancy('lever', LEVER_PREAMBLE)
  assert.equal(none.reason, 'found'); assert.equal(none.vacancy!.quote, '', `no quote: ${none.vacancy!.quote}`)
})

test('Greenhouse: the quote is a verbatim passage of the posting content as the verifier reads it, never across `title company_name content`; a preamble-only posting gives no quote', async () => {
  const r = await vacancy('greenhouse', GH_DESC)
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  assert.ok(ghText(JSON.parse(ghRecord(GH_DESC)).content).includes(q), `the quote is on the posting's own text: ${q}`)
  assert.ok(!/^Account Executive Brightloop/.test(q), 'never across the title / company_name / content join')
  assert.match(q, /We are hiring an Account Executive/)
  const none = await vacancy('greenhouse', GH_PREAMBLE)
  assert.equal(none.reason, 'found'); assert.equal(none.vacancy!.quote, '', `no quote: ${none.vacancy!.quote}`)
})

// #767 reviews R1 (rounds 1 and 2): the quote is the posting stating THIS vacancy. Each input is its own test, so each fails for its own reason.
const NOT_A_VACANCY: [string, string, string][] = [
  ['About Brightloop. Our customers are looking for a faster way to close their books, and finance teams are seeking tools that scale. Benefits: health cover and 30 days holiday.', 'Account Executive', 'customers "looking for" a tool'],
  ['Our Engineering team is hiring for a Staff Backend Engineer this quarter. You will report to the Account Executive Lead and join our sales team.', 'Senior AE', 'another role\'s hiring'],
  ['The Account Executive works with our Account Executive Managers. Team is hiring process lead.', 'Account Executive - London', 'a passing title mention'],
  ['We are hiring an SDR to support our Account Executive team in London.', 'Account Executive', 'the hiring is for another role named first'],
  ['We\'re looking for an Account Executive Manager to lead our team of ten reps in London.', 'Account Executive', 'a role noun after the title: another role'],
  ['Hiring an Account Executive is hard, which is why Brightloop built this tool for recruiters.', 'Account Executive', 'no posting subject: a statement about hiring'],
  ['Competitors are looking for an Account Executive too, but we offer more than they do.', 'Account Executive', 'competitors are the subject'],
  ['Customers are seeking an Account Executive Assistant tool, which is why we built it.', 'Account Executive', 'customers are the subject, and "Assistant tool" follows'],
  ['We\'re looking for a former Account Executive turned founder to advise our board members.', 'Account Executive', '"former": an adviser, not the role'],
  ['We\'re hiring a Sales Engineer to partner with customers across the region soon.', 'Sales', 'title "Sales" inside "Sales Engineer"'],
  ['Our customers are hiring a Account Executive platform.', 'Account Executive', 'customers are the subject'],
  ['Join our community as a customer. Account Executive webinars every week for our users.', 'Account Executive', 'join as a customer'],
  ['Join the Account Executive Academy as an attendee and learn deals every week for free.', 'Account Executive', 'an academy'],
  ['Ready to join Brightloop as a customer? Our Account Executive will onboard you quickly.', 'Account Executive', 'join as a customer, then a passing mention'],
  ['You will join the team as it grows and work with our CRM Administrator.', 'CRM Administrator', '"join ... as" not followed by the title'],
  // round 3: a hyphen compound and a level swap are other roles
  ['We are hiring a Account Executive-led growth marketer to run campaigns.', 'Account Executive', 'a hyphen compound "Account Executive-led growth marketer"'],
  ['We\'re looking for a Junior Account Executive to own deals at Brightloop.', 'Senior Account Executive', 'a Junior role on a Senior posting'],
  ['We\'re looking for a Lead Account Executive to own deals at Brightloop.', 'Senior Account Executive - London', 'a Lead role on a Senior posting'],
]
for (const [text, title, why] of NOT_A_VACANCY) test(`no quote (${why}): ${text.slice(0, 60)}`, () => assert.equal(postingQuote([text], title, 'Brightloop'), '', why))

// round 2 R2: role-tied phrasings that ARE vacancy statements, each its own test. "Join the team as an Account Executive: a pro-sales role." is a deliberate
// positive (the posting's own "join the team as <title>"); "Role: Account Executive" alone (no hiring wording, no "About the role") is a deliberate miss.
const VACANCY: [string, string, string][] = [
  ['Hi there! We’re looking for a new Sales-Assist Representative to join the Sales-Assist Motion at Brightloop.', 'Sales Assist Representative', 'We’re looking for a new Sales-Assist Representative to join the Sales-Assist Motion at Brightloop.'],
  ['Join Brightloop in London as CRM Administrator.', 'CRM Administrator', 'Join Brightloop in London as CRM Administrator.'],
  ['The role: Brightloop is hiring an Account Executive to own the London sales cycle.', 'Account Executive - London', 'The role: Brightloop is hiring an Account Executive to own the London sales cycle.'],
  ['We are looking to hire an Account Executive to close deals at Brightloop.', 'Account Executive', 'We are looking to hire an Account Executive to close deals at Brightloop.'],
  ['As our new Account Executive, you will own the sales cycle at Brightloop.', 'Account Executive', 'As our new Account Executive, you will own the sales cycle at Brightloop.'],
  ['About the role: Account Executive. You will own the sales cycle at Brightloop.', 'Account Executive', 'About the role: Account Executive. You will own the sales cycle at Brightloop.'],
  ['We\'re hiring for the Account Executive role in London at Brightloop.', 'Account Executive', 'We\'re hiring for the Account Executive role in London at Brightloop.'],
  ['We\'re hiring! Account Executive at Brightloop.', 'Account Executive', 'We\'re hiring! Account Executive at Brightloop.'],
  ['We\'re looking for an Account Executive to own deals at Brightloop.', 'Senior Account Executive', 'We\'re looking for an Account Executive to own deals at Brightloop.'],
  ['Join the team as an Account Executive: a pro-sales role at Brightloop.', 'Account Executive', 'Join the team as an Account Executive: a pro-sales role at Brightloop.'],
  // round 3: the posting's own level (also as "Sr."), and the plural, are the same role
  ['We\'re looking for a Senior Account Executive to own deals at Brightloop.', 'Senior Account Executive', 'We\'re looking for a Senior Account Executive to own deals at Brightloop.'],
  ['We\'re looking for a Sr. Account Executive to own deals at Brightloop.', 'Senior Account Executive', 'We\'re looking for a Sr. Account Executive to own deals at Brightloop.'],
  ['We\'re hiring two Account Executives in London at Brightloop.', 'Account Executive', 'We\'re hiring two Account Executives in London at Brightloop.'],
  ['We\'re hiring Account Executives in London at Brightloop.', 'Account Executive', 'We\'re hiring Account Executives in London at Brightloop.'],
]
test('"<company> is hiring" is recognised by the board org / site name when the lead\'s company is not known (a pages-only scan)', () => {
  const t = 'Brightloop is hiring an Account Executive to own the sales cycle end to end.'
  assert.equal(postingQuote([t], 'Account Executive', undefined, true, ['brightloop']), t)
  assert.equal(postingQuote([t], 'Account Executive', undefined, true, ['otherco']), '', 'another name as subject is not this posting speaking')
})
for (const [text, title, quote] of VACANCY) test(`quote (${title}): ${text.slice(0, 60)}`, () => assert.equal(postingQuote([text], title, 'Brightloop'), quote))

// #767 review R2: Greenhouse content is turned into text by the verifier's own functions, so entities (&rsquo; &#8217; &mdash; and a double-escaped &amp;lt;)
// render exactly as on the verifier's page
const GH_ENTITIES = '<h2>About Brightloop</h2><p>Brightloop&rsquo;s software runs finance teams.</p><p>We&#8217;re hiring an Account Executive &mdash; own the London sales cycle for &amp;lt;b&amp;gt;SMB&amp;lt;/b&amp;gt; customers &eacute;tendue.</p>'
test('Greenhouse entities: the quote is byte-for-byte on the page the verifier renders (htmlToText(decode(content)))', async () => {
  const r = await vacancy('greenhouse', GH_ENTITIES)
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  const page = (await verifierPage('greenhouse', GH_ENTITIES)(GH)) as { text: string }
  assert.ok(q.length >= 20 && page.text.includes(q), `the quote is on the verifier's page: ${JSON.stringify(q)} / ${JSON.stringify(page.text)}`)
  assert.match(q, /hiring an Account Executive/)
  assert.doesNotMatch(q, /&(?:rsquo|mdash|#8217|eacute);/, 'no named / numeric entity left literal in the quote')
  assert.match(q, /&lt;b&gt;SMB/, 'a double-escaped tag is decoded once, as the verifier renders it')
})

// round 2 R2: Lever's lists[] bullets are on the verifier's page (atsRecord renders them), so a vacancy stated there is quotable
test('Lever lists[]: a vacancy stated in a bullet list is quoted, verbatim on the page the verifier renders', async () => {
  const rec = JSON.stringify({ id: LEVER_ID, text: 'Account Executive', descriptionPlain: 'Brightloop builds workflow software for finance teams across Europe.', lists: [{ text: 'What you will do', content: '<li>We’re hiring an Account Executive for Brightloop in London</li><li>Own the full cycle</li>' }], additionalPlain: 'Brightloop is an equal opportunity employer.', categories: { location: 'London' }, createdAt: Date.parse(`${POSTED}T09:00:00Z`) })
  const g = async (url: string) => { const u = new URL(url); if (u.hostname === 'api.lever.co') return { status: 200, body: rec, finalUrl: url }; if (u.pathname === '/careers') return { status: 200, body: html(`<ul><li><a href="${LEVER}">Account Executive</a></li></ul>`), finalUrl: url }; return { status: 404, body: '', finalUrl: url } }
  const r = await careersSalesVacancy('brightloop.io', g, { now: NOW, company: 'Brightloop', namedQuote: true })
  assert.equal(r.reason, 'found'); const q = r.vacancy!.quote
  const recd = atsRecord(JSON.parse(rec), atsPostingRef(LEVER)!)
  assert.ok(recd && recd !== 'missing'); const page = atsPageText(recd, recd.description).text
  assert.match(q, /We’re hiring an Account Executive for Brightloop/); assert.ok(page.includes(q), `on the verifier's page: ${q}`)
})

// round 2 R2: an unquotable posting does not hide a later quotable one among the page's sampled hits
test('a posting with no quotable statement does not hide a later quotable posting on the same careers page', async () => {
  const ID2 = '7bcdf381-14c0-4c2c-a26d-fcb6ac67e2c7', ASHBY2 = `https://jobs.ashbyhq.com/brightloop/${ID2}`
  const board = JSON.stringify({ jobs: [
    { id: ID, title: 'Account Executive', isListed: true, publishedAt: `${POSTED}T09:00:00Z`, jobUrl: ASHBY, descriptionPlain: PREAMBLE + 'ABOUT YOU - You are located in London.' },
    { id: ID2, title: 'Sales Development Representative', isListed: true, publishedAt: `${POSTED}T09:00:00Z`, jobUrl: ASHBY2, descriptionPlain: 'We are hiring a Sales Development Representative to build pipeline for Brightloop in London.' },
  ] })
  const g = async (url: string) => { const u = new URL(url); if (u.hostname === 'api.ashbyhq.com') return { status: 200, body: board, finalUrl: url }; if (u.pathname === '/careers') return { status: 200, body: html(`<ul><li><a href="${ASHBY}">Account Executive</a></li><li><a href="${ASHBY2}">Sales Development Representative</a></li></ul>`), finalUrl: url }; return { status: 404, body: '', finalUrl: url } }
  const r = await careersSalesVacancy('brightloop.io', g, { now: NOW, company: 'Brightloop', namedQuote: true })
  assert.equal(r.reason, 'found'); assert.equal(r.vacancy!.url, ASHBY2, 'the quotable posting is preferred')
  assert.equal(r.vacancy!.quote, 'We are hiring a Sales Development Representative to build pipeline for Brightloop in London.')
  const one = await careersSalesVacancy('brightloop.io', async url => { const r2 = await g(url); return new URL(url).pathname === '/careers' ? { ...r2, body: html(`<ul><li><a href="${ASHBY}">Account Executive</a></li></ul>`) } : r2 }, { now: NOW, company: 'Brightloop', namedQuote: true })
  assert.equal(one.reason, 'found'); assert.equal(one.vacancy!.url, ASHBY, 'with no quotable posting the verified vacancy still stands (no quote offered)'); assert.equal(one.vacancy!.quote, '')
})

async function run(board: Board, desc: string, query = 'London B2B SaaS startups hiring sales staff') {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const id = createQueryJob(db, 'A', { query, icp, sources: JSON.stringify({ adapters: ['careers'], pages: ['https://brightloop.io'] }) } as never)
  const url = board === 'ashby' ? ASHBY : board === 'lever' ? LEVER : GH
  // the stubbed extraction model cites the careers item it was given, quoting that item's text (the evidence quote) verbatim, as the source prompt asks
  const extract = (p: string) => {
    const quotes = [...p.matchAll(/\{[^{}]*"source":"careers"[^{}]*\}/g)].map(m => { try { return JSON.parse(m[0]).text as string } catch { return '' } }).filter(Boolean)
    return quotes.length ? JSON.stringify([{ name: '', company: 'Brightloop', contact: null, signal: board === 'ashby' ? 'hiring a Sales Assist Representative' : 'hiring an Account Executive', score: 85, source_url: url, excerpt: quotes[0], event_date: POSTED }]) : '[]'
  }
  const prov = {
    anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string) => p.startsWith('You check one claim') ? 'supports' : extract(p) },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' },
  }
  const res = await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: verifierPage(board, desc) as never, sourceHttp: http(board, desc), crawlGet: async () => null, score: false, now: new Date() })
  const src = db.prepare("SELECT status, evidence_count AS evidence FROM scan_source_runs WHERE collector = 'adapter:careers'").get() as { status: string; evidence: number } | undefined
  return { res, src, rows: listLeads(db, 'A', id) as unknown as { source_url: string; review_reason: string | null; evidence_excerpt: string; event_date: string | null; event_date_proof: string | null }[] }
}
for (const [board, desc, url, onPage] of [['ashby', ASHBY_DESC, ASHBY, flat(ASHBY_DESC)], ['lever', LEVER_DESC, LEVER, flat(LEVER_DESC)], ['greenhouse', GH_DESC, GH, ghText(JSON.parse(ghRecord(GH_DESC)).content)]] as const) {
  test(`runner (${board}): the careers lead is verified through runJob / verifyLeads, not held as quote_unconfirmed, and dated ats_structured`, async () => {
    const x = await run(board, desc)
    assert.equal(x.res, 'done'); assert.deepEqual(x.src, { status: 'ok', evidence: 1 })
    const r = x.rows.find(r => r.source_url === url)
    assert.ok(r, `the posting became a lead: ${JSON.stringify(x.rows)}`)
    assert.equal(r!.review_reason, null, `verified, not held: ${JSON.stringify(r)}`)
    assert.ok(onPage.includes(r!.evidence_excerpt), 'the saved quote is on the posting')
    assert.equal(r!.event_date, POSTED); assert.equal(r!.event_date_proof, 'ats_structured')
  })
}
test('runner: a preamble-only posting yields no careers evidence (quote_too_short), so no lead is made from it', async () => {
  const x = await run('ashby', PREAMBLE + 'ABOUT YOU\n\n - You are located in India.')
  assert.deepEqual(x.src, { status: 'partial', evidence: 0 }, 'the careers source ran, skipped the posting (quote_too_short) and gave no evidence')
  assert.equal(x.rows.filter(r => r.source_url === ASHBY).length, 0)
})
