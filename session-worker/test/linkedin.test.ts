import test from 'node:test'
import assert from 'node:assert/strict'
import { findPeople, findPosts, personItems, linkedinEngagers, linkedinPeople, voyagerGet } from '../src/linkedin.ts'

// Fixtures follow the shapes LinkedIn has used (miniProfile in comments/reactions, entityResult in dash search).
// They are NOT captured from live responses; live behaviour is unverified.
const mini = (id: string, first: string, last: string, occ: string) => ({ 'com.linkedin.voyager.feed.MemberActor': { miniProfile: { firstName: first, lastName: last, occupation: occ, publicIdentifier: id } } })

test('people are found anywhere: miniProfile, dash profile, and search entityResult; deduped; "LinkedIn Member" skipped', () => {
  const raw = { elements: [
    { commenter: mini('jane-doe-1', 'Jane', 'Doe', 'Head of HR at Acme Logistics') },
    { actor: mini('jane-doe-1', 'Jane', 'Doe', 'Head of HR at Acme Logistics') },
    { profile: { firstName: 'Ben', lastName: 'Ortiz', headline: 'Payroll Manager | Beta Corp', publicIdentifier: 'ben-ortiz' } },
    { entityResult: { title: { text: 'Cara Diaz' }, primarySubtitle: { text: 'VP People at Gamma' }, navigationUrl: 'https://www.linkedin.com/in/cara-diaz?miniProfileUrn=x' } },
    { entityResult: { title: { text: 'LinkedIn Member' }, navigationUrl: 'https://www.linkedin.com/in/hidden-1' } },
  ] }
  assert.deepEqual(findPeople(raw), [
    { publicId: 'jane-doe-1', name: 'Jane Doe', headline: 'Head of HR at Acme Logistics' },
    { publicId: 'ben-ortiz', name: 'Ben Ortiz', headline: 'Payroll Manager | Beta Corp' },
    { publicId: 'cara-diaz', name: 'Cara Diaz', headline: 'VP People at Gamma' },
  ])
})

test('items: profile URL, name as title, headline plus action as quote, login_walled', () => {
  const [it] = personItems([{ publicId: 'jane-doe-1', name: 'Jane Doe', headline: 'Head of HR at Acme' }], 'Commented on a LinkedIn post about Rival.', '2026-10-20')
  assert.deepEqual(it, { url: 'https://www.linkedin.com/in/jane-doe-1/', title: 'Jane Doe', quote: 'Jane Doe, Head of HR at Acme. Commented on a LinkedIn post about Rival.', date: '2026-10-20', login_walled: true })
})

test('posts: activity ids with dates from a content search', () => {
  const raw = { elements: [{ trackingUrn: 'urn:li:activity:7123456789012345678', actor: { createdAt: 1760000000000 } }, { entityUrn: 'urn:li:activity:7123456789012345679' }] }
  assert.deepEqual(findPosts(raw), [{ id: '7123456789012345678', date: '2025-10-09' }, { id: '7123456789012345679', date: null }])
})

test('engagers: search -> posts -> commenters and reactors, deduped across posts, action names the competitor', async () => {
  const calls: string[] = []
  const get = async (url: string) => {
    calls.push(url)
    if (url.includes('/search/blended')) return { elements: [{ trackingUrn: 'urn:li:activity:7000000000000000001' }] }
    if (url.includes('/feed/comments')) return { elements: [{ commenter: mini('jane-doe-1', 'Jane', 'Doe', 'Head of HR at Acme') }] }
    if (url.includes('/feed/reactions')) return { elements: [{ actor: mini('jane-doe-1', 'Jane', 'Doe', 'Head of HR at Acme') }, { actor: mini('bo-li', 'Bo', 'Li', 'CFO at Beta') }] }
    return null
  }
  const items = await linkedinEngagers('Rippling', get, 0)
  assert.deepEqual(items.map(i => i.url), ['https://www.linkedin.com/in/jane-doe-1/', 'https://www.linkedin.com/in/bo-li/'])
  assert.ok(items[0].quote.includes('Commented on a LinkedIn post about Rippling') && items[1].quote.includes('Reacted to'))
  assert.equal(calls.length, 3)
})

test('people search mode and session handling', async () => {
  const items = await linkedinPeople('HR manager Ohio', async () => ({ included: [{ entityResult: { title: { text: 'Dana Lee' }, primarySubtitle: { text: 'HR Manager at Acme' }, navigationUrl: 'https://www.linkedin.com/in/dana-lee' } }] }))
  assert.equal(items[0].url, 'https://www.linkedin.com/in/dana-lee/')
  assert.equal(voyagerGet('li_at=abc'), null) // no JSESSIONID: no call
  assert.equal(typeof voyagerGet('li_at=abc; JSESSIONID="ajax:123"'), 'function')
})
