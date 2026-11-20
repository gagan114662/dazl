import assert from 'node:assert/strict'
import test from 'node:test'
import {
  proveCompanyFirstBuyerBySearch, findPublishedOwnDomainEmail, isRoleMailbox,
  type BuyerSearchReaders, type BuyerSearchCandidate, type PublicPage,
} from '../lib/company-first/company-first-buyer-search.ts'
import type { Finding } from '../lib/company-first/company-first-evidence.ts'

// Synthetic fixture names only; nothing here reaches a production path.
const origin = 'https://sample-studio.example'
const scope = { tenant: 'fixture-tenant', job: 'fixture-job', attempt: '1' }
const company = 'Sample Studio', name = 'Jane Quinn', title = 'Head of Sales'
const linkedin = 'https://www.linkedin.com/in/jane-quinn-fixture'
const finding = { state: 'signal_verified', name: company,
  site: { companyKey: 'sample-studio', website: origin, identitySource: origin + '/' },
  signal: { companyKey: 'sample-studio', place: 'Synthetic Market', event: 'hiring', date: '2026-11-01',
    sourceUrl: origin + '/careers/sdr', quote: 'Sample Studio is hiring an SDR.' },
} as const satisfies Finding

function readers(candidate: BuyerSearchCandidate | null, pages: Record<string, string | (PublicPage & {html:string})>, opts: { refuse?: string; stale?: boolean } = {}) {
  const reads: string[] = [], reserves: string[] = []
  const r: BuyerSearchReaders = {
    isCurrent: async () => !opts.stale,
    reserveBeforeDispatch: async ({ stage }) => { reserves.push(stage); return opts.refuse !== stage },
    searchBuyer: async () => candidate,
    readPage: async (url): Promise<PublicPage | null> => { reads.push(url); const p=pages[url];return typeof p==='string'?{url,text:p}:p??null },
  }
  return { r, reads, reserves }
}
const own = origin + '/about/team'
const ownText = `Our team\n${name}\n${title}\n${company}`

test('an exact non-Latin owned name and role can be proved without an English alias', async () => {
  const name = '山田 花子', title = '営業部長'
  const { r } = readers({ name, title, linkedin: null, sources: [own] }, {
    [own]: {url: own, text: `${name}\n${title}`, html: `<article><h2>${name}</h2><p>${title}</p></article>`},
  })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, r), {
    status:'buyer_proof', buyer:{name,title,linkedin:null,proofUrls:[own]},
  })
})
const pageCard=(role=title,profile:string|null=linkedin)=>({url:own,text:ownText,
  html:`<article><h2>${name}</h2><p>${role}</p>${profile?`<a href="${profile}">${name} on LinkedIn</a>`:''}</article>`})
const ownPage=pageCard()

test('buyer proven by one own-site page naming the person and role', async () => {
  const { r, reserves } = readers({ name, title, linkedin, sources: [own] }, { [own]: ownPage })
  const res = await proveCompanyFirstBuyerBySearch(finding, [title], scope, r)
  assert.deepEqual(res, { status: 'buyer_proof', buyer: { name, title, linkedin, proofUrls: [own] } })
  assert.deepEqual(reserves.slice(0, 1), ['buyer_search'])
})

test('two outside copies are not independent proof of a current role', async () => {
  const a='https://news-one.example/story/1',b='https://press-two.example/item/2'
  const text=`${name}, ${title} at ${company}, said...`
  const f=readers({name,title,linkedin:null,sources:[a,b]},{[a]:text,[b]:text})
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding,[title],scope,f.r),{status:'held',reason:'buyer_uncorroborated'})
  assert.deepEqual(f.reads,[])
})

test('literal current card, not a mixed sentence, former role, hidden title or neighboring card', async()=>{
  for(const html of [
    `<article><h2>${name}</h2><p>Designer; Sam Lee is ${title}</p></article>`,
    `<article><h2>${name}</h2><p>Former ${title}</p></article>`,
    `<article><h2>${name}</h2><p>${title}</p><p>Retired after the acquisition.</p></article>`,
    `<section class="team_alumni"><article><h2>${name}</h2><p>${title}</p></article></section>`,
    `<section aria-label="Former team"><article><h2>${name}</h2><p>${title}</p></article></section>`,
    `<main><h1>Leadership archive</h1><article><h2>${name}</h2><p>${title}</p></article></main>`,
    `<article><h2>${name}</h2><p>${title}</p></article><article><h2>${name}</h2><p>Designer</p></article>`,
    `<article><h2>${name}</h2><p hidden>${title}</p></article>`,
    `<article><h2>${name}</h2></article><article><h2>Sam Lee</h2><p>${title}</p></article>`,
  ]){
    const f=readers({name,title,linkedin,sources:[own]},{[own]:{url:own,text:`${name} ${title}`,html}})
    assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding,[title],scope,f.r),{status:'held',reason:'buyer_uncorroborated'},html)
  }
})

test('LinkedIn proposal is never proof; only a literal full-name anchor on the proved card earns a link',async()=>{
  const fromAnother='https://www.linkedin.com/in/jane-other'
  const f=readers({name,title,linkedin:fromAnother,sources:[own]},{[own]:{url:own,text:ownText,
    html:`<article><h2>${name}</h2><p>${title}</p></article><article><h2>Jane Other</h2><a href="${fromAnother}">Jane Other on LinkedIn</a></article>`}})
  const r=await proveCompanyFirstBuyerBySearch(finding,[title],scope,f.r)
  assert.deepEqual(r,{status:'buyer_proof',buyer:{name,title,linkedin:null,proofUrls:[own]}})
})

test('search text alone, LinkedIn alone, or a page without the role never proves the buyer', async () => {
  const onlyLi = readers({ name, title, linkedin, sources: [linkedin] }, {})
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, onlyLi.r), { status: 'held', reason: 'buyer_uncorroborated' })
  assert.deepEqual(onlyLi.reads.includes(linkedin), false)
  const noRole = readers({ name, title, linkedin, sources: [own] }, { [own]: `${name}\nDesigner\n${company}` })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, noRole.r), { status: 'held', reason: 'buyer_uncorroborated' })
})

test('role must be one the user asked for; former roles and bad names are held', async () => {
  for (const c of [
    { name, title: 'Office Manager', linkedin: null, sources: [own] },
    { name, title: 'Former Head of Sales', linkedin: null, sources: [own] },
    { name: 'Head of Sales', title, linkedin: null, sources: [own] },
    { name: 'Jane', title, linkedin: null, sources: [own] },
  ]) {
    const { r } = readers(c, { [own]: `${c.name}\n${c.title}\n${company}` })
    assert.equal((await proveCompanyFirstBuyerBySearch(finding, [title], scope, r)).status, 'held')
  }
})

test('a LinkedIn link that does not carry the person name is dropped, not trusted', async () => {
  const { r } = readers({ name, title, linkedin: 'https://www.linkedin.com/in/someone-else-77', sources: [own] }, { [own]: pageCard(title,null) })
  const res = await proveCompanyFirstBuyerBySearch(finding, [title], scope, r)
  assert.equal(res.status, 'buyer_proof')
  assert.equal(res.status === 'buyer_proof' && res.buyer.linkedin, null)
})

test('no search without signal proof, a reviewed role, a reservation, or a current attempt', async () => {
  const ok = { name, title, linkedin, sources: [own] }
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(null, [title], scope, readers(ok, {}).r), { status: 'held', reason: 'missing_signal_proof' })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [], scope, readers(ok, {}).r), { status: 'held', reason: 'missing_requested_role' })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, readers(ok, { [own]: ownText }, { refuse: 'buyer_search' }).r), { status: 'held', reason: 'contact_scope_unavailable' })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, readers(ok, { [own]: ownText }, { stale: true }).r), { status: 'held', reason: 'contact_scope_unavailable' })
  const capped = readers(ok, { [own]: ownText }, { refuse: 'buyer_page' })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, capped.r), { status: 'held', reason: 'contact_scope_unavailable' })
  assert.deepEqual(capped.reads, [])
})

test('reads at most five pages and only https pages without credentials', async () => {
  const many = Array.from({ length: 9 }, (_, i) => `https://outside-${i}.example/p`)
  const { r, reads } = readers({ name, title, linkedin: null, sources: ['http://plain.example/x', 'https://u:p@x.example/a', ...many] }, {})
  await proveCompanyFirstBuyerBySearch(finding, [title], scope, r)
  assert.ok(reads.length <= 5)
  assert.ok(reads.every(u => u.startsWith('https://outside-')))
})

test('role mailboxes are rejected, including no-reply and careers style', () => {
  for (const local of ['support', 'help', 'info', 'agent', 'sales', 'hello', 'contact', 'admin', 'noreply', 'no-reply', 'no_reply',
    'careers', 'jobs', 'team', 'office', 'billing', 'privacy', 'press', 'marketing', 'hr', 'recruiting', 'talent', 'accounts',
    'finance', 'legal', 'security', 'webmaster', 'postmaster', 'feedback', 'newsletter', 'invoices', 'orders', 'service', 'care', 'donotreply'])
    assert.equal(isRoleMailbox(local), true, local)
  for (const local of ['jane.quinn', 'jquinn', 'janequinn']) assert.equal(isRoleMailbox(local), false, local)
})

test('only a published own-domain named address is returned', () => {
  const page = (text: string) => [{ url: origin + '/about/team', text: `${name}\n${title}\n${text}` }]
  assert.equal(findPublishedOwnDomainEmail(name, page('Email: jane.quinn@sample-studio.example'), origin, title), 'jane.quinn@sample-studio.example')
  assert.equal(findPublishedOwnDomainEmail(name, page('jquinn@sample-studio.example'), origin, title), 'jquinn@sample-studio.example')
  assert.equal(findPublishedOwnDomainEmail(name, page('jane.quinn@gmail.example'), origin, title), null)
  assert.equal(findPublishedOwnDomainEmail(name, page('sales@sample-studio.example'), origin, title), null)
  assert.equal(findPublishedOwnDomainEmail(name, page('noreply@sample-studio.example'), origin, title), null)
  assert.equal(findPublishedOwnDomainEmail(name, page('mark.lee@sample-studio.example'), origin, title), null)
  // Two different named addresses for the same person is ambiguous: held.
  assert.equal(findPublishedOwnDomainEmail(name, page('jane.quinn@sample-studio.example jquinn@sample-studio.example'), origin, title), null)
  // A guessed pattern never appears unless it is literally published.
  assert.equal(findPublishedOwnDomainEmail(name, page('Email us at our site.'), origin, title), null)
  // Outside pages never own the company mailbox.
  assert.equal(findPublishedOwnDomainEmail(name, [{ url: 'https://news.example/x', text: `${name}\njane.quinn@sample-studio.example` }], origin), null)
})

// ---- Qodo review fixes (PR #1439) ----
test('Q1: name and role in unrelated sections of a page do not prove the buyer', async () => {
  const text = `Our team\n${name}\nDesigner\n\nOpen roles\nWe are hiring a ${title}\n${company}`
  const ownR = readers({ name, title, linkedin: null, sources: [own] }, { [own]: text })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, ownR.r), { status: 'held', reason: 'buyer_uncorroborated' })
  const a = 'https://news-one.example/s/1', b = 'https://press-two.example/s/2'
  const split = `${name} spoke at the event.\n\n${company} is hiring a ${title}.`
  const out = readers({ name, title, linkedin: null, sources: [a, b] }, { [a]: split, [b]: split })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, out.r), { status: 'held', reason: 'buyer_uncorroborated' })
})

test('Q2: a subordinate title containing the requested role is not that role', async () => {
  for (const t of ['Assistant to Head of Sales', 'Executive Assistant to the Head of Sales', 'Deputy Head of Sales']) {
    const { r } = readers({ name, title: t, linkedin: null, sources: [own] }, { [own]: `${name}\n${t}` })
    assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, r), { status: 'held', reason: 'buyer_title_off' }, t)
  }
  const { r } = readers({ name, title: 'Head of Sales, EMEA', linkedin: null, sources: [own] }, { [own]: pageCard('Head of Sales, EMEA',null) })
  assert.equal((await proveCompanyFirstBuyerBySearch(finding, [title], scope, r)).status, 'buyer_proof')
})

test('Q3: a page on another subdomain of the company domain is not an own-site page', async () => {
  const sub = 'https://blog.sample-studio.example/team'
  const { r } = readers({ name, title, linkedin: null, sources: [sub] }, { [sub]: ownText })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, r), { status: 'held', reason: 'buyer_uncorroborated' })
  assert.equal(findPublishedOwnDomainEmail(name, [{ url: sub, text: `${name}\njane.quinn@sample-studio.example` }], origin), null)
})

test('Q4: a first-name-only or namesake mailbox is not given to the buyer', () => {
  const page = (text: string) => [{ url: own, text }]
  assert.equal(findPublishedOwnDomainEmail(name, page(`${name}\n${title}\njane@sample-studio.example`), origin, title), null)
  // jquinn next to a different Quinn belongs to them, not the buyer.
  assert.equal(findPublishedOwnDomainEmail(name, page(`${name}\n${title}\n\nJohn Quinn\nDesigner\njquinn@sample-studio.example`), origin, title), null)
})

test('Q5: an own-site page proposed after five outside pages is still checked first', async () => {
  const outside = Array.from({ length: 5 }, (_, i) => `https://outside-${i}.example/p`)
  const { r, reads } = readers({ name, title, linkedin: null, sources: [...outside, own] }, { [own]: ownPage })
  const res = await proveCompanyFirstBuyerBySearch(finding, [title], scope, r)
  assert.equal(res.status, 'buyer_proof')
  assert.deepEqual(reads, [own])
})

test('Q6: a failed page read stops all further paid reads', async () => {
  const a = origin+'/broken', b = own
  const reserves: string[] = [], reads: string[] = []
  const r: BuyerSearchReaders = {
    isCurrent: async () => true,
    reserveBeforeDispatch: async ({ stage }) => { reserves.push(stage); return true },
    searchBuyer: async () => ({ name, title, linkedin: null, sources: [a, b] }),
    readPage: async url => { reads.push(url); throw new Error('usage unknown') },
  }
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, r), { status: 'held', reason: 'read_failed' })
  assert.deepEqual(reads, [a])
  assert.deepEqual(reserves, ['buyer_search', 'buyer_page'])
})
