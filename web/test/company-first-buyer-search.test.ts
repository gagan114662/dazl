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

function readers(candidate: BuyerSearchCandidate | null, pages: Record<string, string>, opts: { refuse?: string; stale?: boolean } = {}) {
  const reads: string[] = [], reserves: string[] = []
  const r: BuyerSearchReaders = {
    isCurrent: async () => !opts.stale,
    reserveBeforeDispatch: async ({ stage }) => { reserves.push(stage); return opts.refuse !== stage },
    searchBuyer: async () => candidate,
    readPage: async (url): Promise<PublicPage | null> => { reads.push(url); return url in pages ? { url, text: pages[url] } : null },
  }
  return { r, reads, reserves }
}
const own = origin + '/about/team'
const ownText = `Our team\n${name}\n${title}\n${company}`

test('buyer proven by one own-site page naming the person and role', async () => {
  const { r, reserves } = readers({ name, title, linkedin, sources: [own] }, { [own]: ownText })
  const res = await proveCompanyFirstBuyerBySearch(finding, [title], scope, r)
  assert.deepEqual(res, { status: 'buyer_proof', buyer: { name, title, linkedin, proofUrls: [own] } })
  assert.deepEqual(reserves.slice(0, 1), ['buyer_search'])
})

test('buyer proven by two independent outside pages, not by one', async () => {
  const a = 'https://news-one.example/story/1', b = 'https://press-two.example/item/2', b2 = 'https://news-one.example/story/2'
  const text = `${name}, ${title} at ${company}, said...`
  const two = readers({ name, title, linkedin: null, sources: [a, b] }, { [a]: text, [b]: text })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, two.r),
    { status: 'buyer_proof', buyer: { name, title, linkedin: null, proofUrls: [a, b] } })
  const sameHost = readers({ name, title, linkedin: null, sources: [a, b2] }, { [a]: text, [b2]: text })
  assert.deepEqual(await proveCompanyFirstBuyerBySearch(finding, [title], scope, sameHost.r), { status: 'held', reason: 'buyer_uncorroborated' })
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
  const { r } = readers({ name, title, linkedin: 'https://www.linkedin.com/in/someone-else-77', sources: [own] }, { [own]: ownText })
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
  const host = 'sample-studio.example'
  const page = (text: string) => [{ url: origin + '/about/team', text }]
  assert.equal(findPublishedOwnDomainEmail(name, page('Reach Jane: jane.quinn@sample-studio.example'), host), 'jane.quinn@sample-studio.example')
  assert.equal(findPublishedOwnDomainEmail(name, page('jquinn@sample-studio.example'), host), 'jquinn@sample-studio.example')
  assert.equal(findPublishedOwnDomainEmail(name, page('jane.quinn@gmail.example'), host), null)
  assert.equal(findPublishedOwnDomainEmail(name, page('sales@sample-studio.example'), host), null)
  assert.equal(findPublishedOwnDomainEmail(name, page('noreply@sample-studio.example'), host), null)
  assert.equal(findPublishedOwnDomainEmail(name, page('mark.lee@sample-studio.example'), host), null)
  // Two different named addresses for the same person is ambiguous: held.
  assert.equal(findPublishedOwnDomainEmail(name, page('jane.quinn@sample-studio.example jquinn@sample-studio.example'), host), null)
  // A guessed pattern never appears unless it is literally published.
  assert.equal(findPublishedOwnDomainEmail(name, page('Email us at our site.'), host), null)
  // Outside pages never own the company mailbox.
  assert.equal(findPublishedOwnDomainEmail(name, [{ url: 'https://news.example/x', text: 'jane.quinn@sample-studio.example' }], host), null)
})
