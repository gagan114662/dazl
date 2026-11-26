import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateEmailGuess, personalAddresses, publishedCandidateFor, recordEmailGuesses } from '../lib/people/email-pattern.ts'

// Recorded visible profile excerpts. The selection has no US ZIP proof.
const pages = [
  { where: ['Dubai, United Arab Emirates'], home: 'Dubai', site: 'akingump.com',
    url: 'https://www.akingump.com/en/lawyers-advisors/graham-lovett', name: 'Graham Lovett', title: 'Partner',
    text: 'Graham Lovett\nPartner, Commercial Arbitration & Litigation\nSend Email (glovett@akingump.com)',
    address: 'glovett@akingump.com', basis: 'scan geography names AE' },
  { where: ['United Kingdom'], home: 'North London', site: 'pellings.co.uk',
    url: 'https://pellings.co.uk/contact-us/management-directory/', name: 'Mark Brown', title: 'Managing Director',
    text: 'Mark Brown BSc (Hons) MRICS\nManaging Director\nSend email (mbrown@pellings.co.uk)',
    address: 'mbrown@pellings.co.uk', basis: 'scan geography names GB' },
  { where: ['Australia'], home: 'Sydney', site: 'bartier.com.au',
    url: 'https://www.bartier.com.au/our-team/darren-gardner', name: 'Darren Gardner', title: 'Partner',
    text: 'Darren Gardner\nPartner*\nView contact details +\ndgardner@bartier.com.au',
    address: 'dgardner@bartier.com.au', basis: 'scan geography names AU' },
  { where: ['United States'], home: 'Cleveland', site: 'beneschlaw.com',
    url: 'https://www.beneschlaw.com/contact-us/', name: 'Jeanne Hammerstrom', title: 'Chief Marketing Officer',
    text: 'Jeanne Hammerstrom\nChief Marketing Officer\nCleveland\njhammerstrom@beneschlaw.com',
    address: 'jhammerstrom@beneschlaw.com', basis: 'no US address on the homepage: country unknown' },
]

for (const page of pages) test(`published work email survives the geography gate: ${page.site}`, () => {
  const db = new Database(':memory:')
  try {
    const seen = personalAddresses(page.text, page.site).map(({ address }) => ({ address, url: page.url }))
    assert.deepEqual(seen, [{ address: page.address, url: page.url }])
    const result = recordEmailGuesses(db, 'tenant', 'lead', page.site, [], [`${page.name}, ${page.title}`],
      { env: {}, where: page.where, homeText: page.home, seen })
    assert.equal(result?.published, 1)
    assert.deepEqual(publishedCandidateFor(db, 'tenant', 'lead', page.name), { address: page.address, url: page.url })
    assert.deepEqual(db.prepare('SELECT country_basis, tier FROM email_candidates').get(),
      { country_basis: page.basis, tier: 'published' })
  } finally { db.close() }
})

test('foreign scope does not attach another person’s address, an off-site address, or a guess', () => {
  const db = new Database(':memory:')
  try {
    migrateEmailGuess(db)
    const page = pages[1]
    recordEmailGuesses(db, 'tenant', 'lead', page.site, ['cwong', 'aevans'], ['Casey Wong, Owner', 'Alex Evans, Director'], {
      env: { EMAIL_GUESS_ENABLED: '1' }, where: page.where, homeText: page.home,
      seen: [{ address: page.address, url: page.url },
        { address: 'cwong@elsewhere.example', url: page.url }],
    })
    assert.deepEqual(db.prepare('SELECT address FROM email_candidates').all(), [])
  } finally { db.close() }
})
