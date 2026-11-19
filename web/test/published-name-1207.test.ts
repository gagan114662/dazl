import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateEmailGuess, publishedFor, recordEmailGuesses, selectPublishedCandidate } from '../lib/people/email-pattern.ts'

const url = 'https://acme.example/team'
const seen = (address: string, tight: string) => [{ address, url, ctx: [{ tight, wide: tight, attr: true }] }]
const chars = ['[', ']', '(', ')', '+', '*', '?', '.', '\\', '|', '^', '$', '{', '}']

test('#1207 the pure matcher refuses a malformed first or last token without throwing or attributing', () => {
  for (const ch of chars) for (const name of [{ first: 'ma' + ch + 'ya', last: 'thornton' }, { first: 'maya', last: 'thor' + ch + 'nton' }]) {
    assert.equal(publishedFor(name, seen('maya@acme.example', 'Maya Thornton maya@acme.example')), null)
    assert.equal(publishedFor(name, seen('thornton@acme.example', 'Maya Thornton thornton@acme.example')), null)
    const first = name.first, last = name.last
    assert.equal(publishedFor(name, seen(first + '.' + last + '@acme.example', first + ' ' + last)), null)
  }
})

test('#1207 the crawl writer and historical selector never silently collapse malformed names to another person', () => {
  for (const flag of ['0', '1']) {
    const db = new Database(':memory:')
    migrateEmailGuess(db)
    const write = (person: string, nameOnPage: string) => recordEmailGuesses(db, 'test', 'lead', 'acme.example', [], [person], {
      env: { EMAIL_GUESS_ENABLED: flag }, homeText: '123 Main St, Austin, TX 78701', seen: seen('maya@acme.example', nameOnPage),
    })
    for (const spelling of ['Maya', 'Maaya', 'Ma Ya']) {
      write('Ma+ya Thornton, Owner', spelling + ' Thornton maya@acme.example')
      assert.equal(db.prepare("SELECT count(*) n FROM email_candidates").pluck().get(), 0, 'not ' + spelling)
    }
    write('Maya Thor[nton, Owner', 'Maya Thornton maya@acme.example')
    assert.equal(db.prepare("SELECT count(*) n FROM email_candidates").pluck().get(), 0)
    write('Dr. Māya O. Thornton, Owner', 'Maya O. Thornton maya@acme.example')
    assert.equal(db.prepare("SELECT count(*) n FROM email_candidates WHERE tier='published'").pluck().get(), 1, 'legitimate honorific, accent and middle initial')
    db.close()
  }
  const good = [{ person: 'Maya Thornton, Owner', address: 'maya@acme.example', source_url: url }]
  assert.equal(selectPublishedCandidate(good, 'Ma+ya Thornton'), null)
  assert.equal(selectPublishedCandidate([{ ...good[0], person: 'Ma+ya Thornton, Owner' }], 'Maya Thornton'), null)
  assert.deepEqual(selectPublishedCandidate(good, 'Māya Thornton'), { address: 'maya@acme.example', url })
})

test('#1207 a rejected namesake still blocks its possible address, with a count and no identity in the diagnostic', () => {
  const db = new Database(':memory:')
  migrateEmailGuess(db)
  const rejected: number[] = []
  recordEmailGuesses(db, 'test', 'lead', 'acme.example', [], ['Maya Thornton', 'Ma+ya Ortiz', 'Nora Brown'], {
    env: { EMAIL_GUESS_ENABLED: '0' }, homeText: '123 Main St, Austin, TX 78701',
    seen: [...seen('maya@acme.example', 'Maya Thornton maya@acme.example'), ...seen('nora@acme.example', 'Nora Brown nora@acme.example')],
    onMalformedNames: count => rejected.push(count),
  })
  assert.deepEqual(rejected, [1])
  assert.deepEqual(db.prepare("SELECT address FROM email_candidates WHERE tier='published'").pluck().all(), ['nora@acme.example'])
  db.close()
})

test('#1207 a malformed historical row is a veto for discordant addresses, never a positive address source', () => {
  const valid = { person: 'Maya Thornton, CTO', address: 'maya@acme.example', source_url: url }
  const malformed = { person: 'Ma+ya Thornton, Owner', address: 'other@acme.example', source_url: url }
  assert.equal(selectPublishedCandidate([valid, malformed], 'Maya Thornton'), null, 'do not erase pre-existing ambiguity')
  assert.equal(selectPublishedCandidate([malformed], 'Maya Thornton'), null, 'malformed rows cannot supply positive proof')
  assert.deepEqual(selectPublishedCandidate([{ ...malformed, address: valid.address, source_url: url + '/old' }, valid], 'Maya Thornton'), { address: valid.address, url }, 'a valid corroboration retains its own source')
})
