// #1319 items 6, 7 and 3: a first-time password user can reach the free trial (which needs Google linked).
// (7) a plus-alias sign-up (name+x@domain) links the Google account for name@domain; any other address is still refused,
// and only an exact match confirms the account's email. (6) Home's "Search can run" step offers Link Google first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPasswordUser, createSession } from '../lib/auth-db.ts'
import { linkGoogle } from '../lib/auth-google.ts'
import { emailStatus } from '../lib/email-ownership.ts'
import { googleAccountHint, googleLinkResultCopy, mailboxKey, sameMailbox } from '../lib/google-link.ts'
import { readyItems } from '../lib/ready-card.ts'
import { noticeAccount } from '../lib/trial-copy.ts'
import { bothEngines } from './helpers/engines.ts'

const user = (id: string, email: string) => ({ id, email, name: id, business_name: id, password_hash: 'h', salt: 's' })
const G = (email: string, sub = `g-${email}`) => ({ sub, email, name: 'G' })

test('mailboxKey: only a +tag and letter case are set aside; different mailboxes never match', () => {
  assert.equal(mailboxKey('Pat+Dazl@Example.test'), 'pat@example.test')
  assert.equal(mailboxKey('pat@example.test'), 'pat@example.test')
  assert.ok(sameMailbox('pat+trial@example.test', 'pat@example.test'))
  assert.ok(sameMailbox('pat@example.test', 'PAT@example.test'))
  assert.ok(!sameMailbox('pat@example.test', 'pat@other.test'), 'another domain')
  assert.ok(!sameMailbox('pat@example.test', 'p.at@example.test'), 'no dot folding')
  assert.ok(!sameMailbox('pat@example.test', 'patrick@example.test'))
  assert.ok(!sameMailbox('+x@example.test', 'x@example.test'), 'a leading + is not a tag')
  assert.ok(!sameMailbox('', ''))
})

test('the Link Google box says which Google account to use', () => {
  assert.equal(googleAccountHint('pat+trial@example.test'), 'Use the Google account for pat@example.test.')
  assert.equal(googleAccountHint(undefined), null)
  const acc = noticeAccount({ email: 'pat+trial@example.test', verified: false, google: false }, { fresh: true })
  assert.ok(acc !== 'failed' && acc.email === 'pat+trial@example.test')
  assert.match(googleLinkResultCopy('taken').text, /already signs in to another dazl account/)
  assert.match(googleLinkResultCopy('mismatch').text, /uses a different email/)
})

bothEngines('#1319: a +tag sign-up links the Google account for its mailbox, without confirming the +tag address; others stay mismatch; taken guard kept', async ({ db }) => {
  await createPasswordUser(user('P', 'pat+trial@example.test'), db)
  await createPasswordUser(user('Q', 'quinn@example.test'), db)
  const s = await createSession('P', db)
  assert.equal(await linkGoogle(db, 'P', G('someone@example.test'), s), 'mismatch', 'another mailbox never links')
  assert.equal(await linkGoogle(db, 'P', G('pat@other.test'), s), 'mismatch', 'same name, another domain never links')
  assert.equal(await linkGoogle(db, 'P', G('pat@example.test'), s), 'linked')
  assert.deepEqual(await emailStatus(db, 'P'), { email: 'pat+trial@example.test', verified: false, google: true }, 'Google vouched for pat@, not the +tag address')
  // one Google account per dazl account: the same Google cannot link a second account
  const sq = await createSession('Q', db)
  assert.equal(await linkGoogle(db, 'Q', G('pat@example.test'), sq), 'taken')
  // an exact match still confirms the address (#1095)
  assert.equal(await linkGoogle(db, 'Q', G('quinn@example.test'), sq), 'linked')
  assert.equal((await emailStatus(db, 'Q'))!.verified, true)
})

test('#1319 (6): Search can run offers Link Google (free trial) first, See your plan second, when only Google blocks the trial', () => {
  const base = { profile: null, outreach: null, jobs: [], totals: { searches: 0, finished: 0 }, sources: { web_index: false, news: true, websites: true }, keys: [], advanced: null, messages: [], campaigns: [] }
  const blocked = readyItems({ ...base, usage: { has_key: false, scans_used: 0, scan_limit: 10, trial: { funded: false, remaining: 3, blocked: 'google_required' } } } as never)
  const s = blocked.find(x => x.id === 'search')!
  assert.equal(s.state, 'todo')
  assert.equal(s.fix?.label, 'Link Google (free trial)')
  assert.ok(s.fix?.primary)
  assert.match(s.fix!.href, /^\/api\/auth\/google\?link=1&next=%2Fapp%2Fleads$/)
  assert.deepEqual(s.alt, { href: '/app/settings#plan', label: 'See your plan' })
  // another refusal (e.g. the domain already had its trial): See your plan only, as before
  const other = readyItems({ ...base, usage: { has_key: false, scans_used: 0, scan_limit: 10, trial: { funded: false, remaining: 0, blocked: 'domain_used' } } } as never).find(x => x.id === 'search')!
  assert.equal(other.fix?.label, 'See your plan')
  assert.equal(other.alt ?? null, null)
})
