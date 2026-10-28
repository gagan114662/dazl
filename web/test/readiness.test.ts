import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capNotice, readinessRows, recentPlays } from '../lib/readiness.ts'

const byId = (rows: ReturnType<typeof readinessRows>) => Object.fromEntries(rows.map(r => [r.id, r]))

const job = (o: object = {}) => ({ id: 'j', status: 'done', error: null, query: 'Dentists in Ohio', csv_domain: null, created_at: 1, lead_count: 0, ...o })

test('a new account: the steps in order, each to-do with its fix; Gmail goes to Settings where its consent text is', () => {
  const r = byId(readinessRows({ profile: { sells: '', website: '' }, usage: { has_key: false, trial: null }, outreach: { gmail: null, sender: null, daily_cap: 20, sent_24h: 0 }, jobs: [], sources: { web_index: false, news: false, websites: false } }))
  assert.deepEqual(Object.keys(r), ['site', 'brain', 'play', 'key', 'sources', 'gmail', 'sender', 'limit'])
  assert.deepEqual(Object.values(r).map(x => x.state), ['todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'done'])
  assert.deepEqual(r.brain.fix, { kind: 'link', href: '/app?setup=brain', label: 'Build' })
  assert.equal(r.site.label, 'Website and business details', 'business details only: the buyer profile is not checked')
  assert.deepEqual(r.play.fix, { kind: 'link', href: '/app/leads', label: 'Write a play' })
  assert.equal(r.key.detail, 'needed for searches')
  assert.deepEqual(r.gmail.fix, { kind: 'link', href: '/app/settings#gmail', label: 'Connect' })
  assert.deepEqual(r.sender.fix, { kind: 'inline', label: 'Add' })
  assert.equal(r.limit.detail, 'up to 20 emails a day; 0 sent in the last 24 hours')
})

test('a ready account: all done, no fixes offered', () => {
  const r = readinessRows({ profile: { sells: 'Booking software', website: 'https://acme.example', business_name: 'Acme', buyer: { summary: 'Independent dental practices', who: ['Practice owner'] } }, usage: { has_key: true, trial: null }, outreach: { gmail: { email: 'me@acme.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus OH' }, daily_cap: 12, sent_24h: 3 }, jobs: [job()], sources: { web_index: true, news: true, websites: true } })
  assert.ok(r.every(x => x.state === 'done' && x.fix === null))
  assert.equal(byId(r).sources.detail, 'a scan can use Web research with your AI key, Web search index, News articles, Company websites')
  assert.equal(byId(r).gmail.detail, 'sending from me@acme.example')
  assert.equal(byId(r).site.detail, 'Acme - Booking software (acme.example)')
  assert.equal(byId(r).play.detail, '1 search written')
  assert.equal(byId(r).limit.detail, 'up to 12 emails a day; 3 sent in the last 24 hours')
})

test('a failed status load is "could not check", never done or to-do', () => {
  const r = readinessRows({ profile: null, usage: null, outreach: null, jobs: null, sources: null })
  assert.ok(r.every(x => x.state === 'unknown' && x.fix === null))
  assert.equal(byId(readinessRows({ profile: null, usage: null, outreach: {} })).limit.state, 'unknown', 'no cap reported: not claimed as set')
})

test('first play: any own search counts, whatever it found; imports and test fixtures do not', () => {
  const play = (jobs: object[]) => byId(readinessRows({ profile: null, usage: null, outreach: null, jobs: jobs as never })).play
  assert.equal(play([job({ csv_domain: 'acme.com' }), job({ test_only: true }), job({ query: null })]).state, 'todo')
  assert.equal(play([job({ status: 'failed', error: 'no_candidates' })]).state, 'done')
  assert.equal(play([job(), job({ id: 'k' })]).detail, '2 searches written')
})

test('free searches cover the first scan: the key row is done while they last and a to-do once they run out', () => {
  const key = (trial: object | null) => byId(readinessRows({ profile: null, usage: { has_key: false, trial: trial as never }, outreach: null })).key
  assert.deepEqual([key({ funded: true, remaining: 2 }).state, key({ funded: true, remaining: 2 }).detail, key({ funded: true, remaining: 2 }).fix], ['done', 'using free searches (2 left)', null])
  assert.equal(key({ funded: true, remaining: 1 }).detail, 'using free searches (1 left)')
  assert.equal(key({ funded: true, remaining: 0 }).state, 'todo')
  assert.equal(key({ funded: false, remaining: 5 }).state, 'todo')
})

test('Gmail that needs reconnecting and a half-filled sender are to-dos', () => {
  const r = byId(readinessRows({ profile: { sells: 'x', website: '' }, usage: { has_key: true }, outreach: { gmail: { email: 'a@b.example', status: 'revoked' }, sender: { sender_name: 'Dana', postal_address: '' } } }))
  assert.equal(r.site.detail, 'missing business name, website')
  assert.equal(r.gmail.fix?.label, 'Reconnect')
  assert.equal(r.sender.state, 'todo')
})

test('plays: own searches newest first with their outcome; imports and fixtures excluded', () => {
  const j = (id: string, created_at: number, o: object = {}) => ({ id, status: 'done', error: null, query: `q${id}`, csv_domain: null, created_at, lead_count: 3, verified: 3, needs_review: 0, ...o })
  const p = recentPlays([j('1', 1), j('2', 3, { status: 'failed' }), j('3', 2, { lead_count: 1, verified: 1 }), j('4', 4, { csv_domain: 'acme.com' }), j('5', 5, { test_only: true }), j('6', 6, { status: 'running', query: null })])
  assert.deepEqual(p, [{ id: '2', query: 'q2', outcome: 'failed' }, { id: '3', query: 'q3', outcome: '1 source-checked, 0 need your review' }, { id: '1', query: 'q1', outcome: '3 source-checked, 0 need your review' }])
})

// Instinct #234: a finished search whose leads are all research-only must not read as "5 leads" of yield.
test('plays never present research-only leads as yield; old records and cancelled runs say what they are', () => {
  const j = (o: object) => recentPlays([{ id: 'x', status: 'done', error: null, query: 'q', csv_domain: null, created_at: 1, lead_count: 5, ...o }])[0].outcome
  assert.equal(j({ verified: 0, needs_review: 5 }), '0 source-checked, 5 need your review', 'the real NYC shape: all five need review')
  assert.equal(j({ verified: 2, needs_review: 3 }), '2 source-checked, 3 need your review')
  assert.equal(j({ verified: 0, needs_review: 1, lead_count: 1 }), '0 source-checked, 1 needs your review')
  assert.equal(j({ candidates: 4, verified: 0, needs_review: 0, dropped: 4, lead_count: 0 }), '4 found, all dropped by the checks', 'all-rejected is its own outcome')
  assert.equal(j({ candidates: 0, verified: 0, needs_review: 0, lead_count: 0 }), 'no candidates extracted')
  assert.equal(j({ verified: null, needs_review: null }), 'counts unavailable', 'old record: never a lead total')
  assert.equal(j({ verified: null, needs_review: null, lead_count: 0 }), 'counts unavailable')
  assert.equal(j({ status: 'failed', error: 'cancelled' }), 'cancelled')
  assert.equal(j({ status: 'failed', error: 'no_candidates' }), 'no candidates extracted', 'not a failure, and not proof of no matches')
  assert.equal(j({ status: 'failed', error: 'key_rejected', funded_by: 'user' }), 'failed: AI key rejected', "'user' is the column default, not proof")
  assert.equal(j({ status: 'failed', error: 'key_rejected', funded_by: 'trial' }), 'failed: free-search key trouble')
  assert.equal(j({ status: 'failed', error: 'key_rejected' }), 'failed: AI key rejected', 'unknown funding: neutral, never a service outage')
  assert.equal(j({ status: 'enriching' }), 'finishing')
  assert.equal(j({ status: 'failed', error: 'budget_stopped' }), 'stopped', 'a budget stop is not an empty search')
  assert.equal(j({ status: 'failed', error: 'provider exploded' }), 'failed')
})

// Instinct #246: a finished setup hid the checklist, and with it why sending had stopped.
test('an exhausted daily limit is a notice of its own, shown even when every step is done', () => {
  const ready = { profile: { sells: 'Booking software', website: 'https://acme.example', business_name: 'Acme', buyer: { summary: 'Dental practices', who: ['Owner'] } }, usage: { has_key: true, trial: null }, jobs: [job()], sources: { web_index: true, news: true, websites: true } }
  const outreach = { gmail: { email: 'me@acme.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus OH' }, daily_cap: 20, sent_24h: 14, account_sent_24h: 20 }
  assert.ok(readinessRows({ ...ready, outreach }).every(x => x.state === 'done'), 'the checklist is complete (and hidden)')
  assert.equal(capNotice(outreach), "Today's 20-email limit is used up (20 sent in the last 24 hours). Sending resumes as those sends pass 24 hours old.")
  assert.equal(byId(readinessRows({ ...ready, outreach })).limit.detail, 'up to 20 emails a day; 20 sent in the last 24 hours', 'the row counts the whole account budget')
})

test('the cap notice: follow-ups count, first touches alone are a lower bound, under the cap or unknown says nothing', () => {
  assert.match(capNotice({ daily_cap: 20, sent_24h: 3, account_sent_24h: 21 })!, /used up \(21 sent/, 'follow-ups and sequence steps use the same budget')
  assert.match(capNotice({ daily_cap: 12, sent_24h: 12 })!, /^Today's 12-email limit is used up/, 'older server without the account count')
  assert.equal(capNotice({ daily_cap: 20, sent_24h: 5, account_sent_24h: 19 }), null)
  assert.equal(capNotice({ daily_cap: 20 }), null, 'no count: never claimed as used up')
  assert.equal(capNotice(null), null)
})

test('the outreach settings GET reports the whole account budget, read-only', async () => {
  const { readFileSync } = await import('node:fs')
  const route = readFileSync(new URL('../app/api/outreach/settings/route.ts', import.meta.url), 'utf8')
  assert.match(route, /account_sent_24h: accountSendCount\(db, user\.id, /)
})

test('lead sources: capabilities, never "searched"; no usable key means a scan cannot start, whatever else is on', () => {
  const src = (sources: object | null | undefined, usage: object | null) => byId(readinessRows({ profile: null, usage: usage as never, outreach: null, sources: sources as never })).sources
  const ON = { web_index: false, news: true, websites: false }
  // Instinct #255: enabled news must not make the row done when no scan can start.
  const nokey = src(ON, { has_key: false, trial: null })
  assert.deepEqual([nokey.state, nokey.detail, nokey.fix], ['todo', 'a scan cannot start until you add an AI key. Not available: Web search index (not set up on this server), Company websites (not set up on this server)', { kind: 'link', href: '/app/settings#model-key', label: 'Add key' }])
  assert.equal(src(ON, { has_key: false, trial: { funded: true, remaining: 0 } }).state, 'todo', 'free searches used up')
  assert.deepEqual(src(ON, { has_key: true }), { id: 'sources', label: 'Lead sources', state: 'done', detail: 'a scan can use Web research with your AI key, News articles. Not available: Web search index (not set up on this server), Company websites (not set up on this server)', fix: null })
  assert.equal(src(ON, { has_key: false, trial: { funded: true, remaining: 2 } }).state, 'done', 'free searches left')
  assert.equal(src({ web_index: false, news: false, websites: false }, { has_key: true }).state, 'done', 'web research with the saved key')
  for (const st of [src(ON, { has_key: true }), nokey]) assert.doesNotMatch(st.detail, /search(es|ed)\b/, 'never claims sources are searched')
  assert.deepEqual([src(null, { has_key: true }).state, src(undefined, { has_key: true }).state, src(ON, null).state], ['unknown', 'unknown', 'unknown'], 'a failed or missing check is never done')
})

test('brain: done only with a saved buyer profile (who or a summary); the fix reopens the setup steps at the brain', () => {
  const brain = (buyer: unknown) => byId(readinessRows({ profile: { sells: 'x', website: 'https://a.example', business_name: 'A', buyer: buyer as never }, usage: null, outreach: null })).brain
  assert.deepEqual([brain(null).state, brain(undefined).state, brain({ summary: ' ', who: [] }).state], ['todo', 'todo', 'todo'])
  assert.deepEqual(brain({ summary: '', who: ['Practice owner', 'Office manager'] }), { id: 'brain', label: 'Buyer profile (who buys from you)', state: 'done', detail: 'Practice owner, Office manager', fix: null })
  assert.equal(brain({ summary: 'Independent dental practices', who: [] }).detail, 'Independent dental practices')
  assert.equal(byId(readinessRows({ profile: null, usage: null, outreach: null })).brain.state, 'unknown')
})

// Home readiness: "AI key valid" and truthful source availability.
// Instinct #275: the evidence (and what clears it) is server-side and key-specific (test/key-evidence.test.ts); Home only
// reports it, and never infers acceptance from other scans or another provider's key.
test('AI key: done with no open rejection; a server-reported rejection of a known key names that key; unknown says so', () => {
  const key = (keys: object[] | null, rejection: object | null, jobs: object[] = []) => byId(readinessRows({ profile: null, usage: { has_key: true }, outreach: null, keys: keys as never, rejection: rejection as never, jobs: jobs as never })).key
  const K = [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1000 }]
  const K2 = [...K, { vendor: 'openai', last4: 'Zz99', validated_at: 5000 }]
  assert.deepEqual(key(K, null), { id: 'key', label: 'AI key', state: 'done', detail: 'saved (ending Ab12); your provider accepted it when it was saved', fix: null })
  const refused = key(K2, { error: 'key_rejected', vendor: 'anthropic' })
  assert.deepEqual([refused.state, refused.detail, refused.fix], ['todo', 'your Anthropic key (ending Ab12) was rejected by Anthropic on a scan after it was last saved - save it again to confirm it works', { kind: 'inline', label: 'Replace key' }], "the other provider's newer save does not clear it")
  assert.equal(key(K, { error: 'key_unreadable', vendor: 'anthropic' }).detail, 'dazl could not read your Anthropic key (ending Ab12) on a scan after it was last saved - save it again')
  assert.equal(key(K, { error: 'key_rejected', vendor: null }).detail, 'a scan stopped because its AI key was rejected after your key was last saved - save your key again to confirm it works', 'unknown key identity: no key is named')
  // Home never decides acceptance itself: a later done or cancelled scan in the jobs list changes nothing.
  const job = (created_at: number, status: string, error: string | null) => ({ id: String(created_at), status, error, query: 'q', csv_domain: null, created_at, lead_count: 0 })
  assert.equal(key(K, { error: 'key_rejected', vendor: 'anthropic' }, [job(2000, 'failed', 'key_rejected'), job(3000, 'failed', 'cancelled'), job(4000, 'done', null)]).state, 'todo')
  assert.equal(key(K, null, [job(2000, 'failed', 'key_rejected')]).state, 'done', 'the jobs list alone is not evidence; the server read is')
  assert.equal(key(null, null).detail, 'saved', 'key status not loaded: no claim either way')
  const src = byId(readinessRows({ profile: null, usage: { has_key: true }, outreach: null, keys: K as never, rejection: { error: 'key_rejected', vendor: 'anthropic' }, sources: { web_index: true, news: true, websites: true } })).sources
  assert.deepEqual([src.state, src.detail, src.fix], ['todo', 'a scan may not run until you save your AI key again', { kind: 'link', href: '/app/settings#model-key', label: 'Replace key' }], 'a rejected key is not listed as a usable source')
})

test('lead sources: only usable sources are named as usable; social sources that are not set up are listed with their reason and fix', () => {
  const ALL = { web_index: true, news: true, websites: true }
  const adv = { available: true, platforms: [
    { platform: 'x', allowed: true, consent: true, connected: false, enabled: false, operator_index: true },
    { platform: 'linkedin', allowed: true, consent: false, connected: false, enabled: false },
    { platform: 'reddit', allowed: false, consent: false, connected: false, enabled: false },
  ] }
  const row = byId(readinessRows({ profile: null, usage: { has_key: true }, outreach: null, sources: ALL, advanced: adv as never })).sources
  assert.equal(row.state, 'done')
  assert.equal(row.detail, 'a scan can use Web research with your AI key, Web search index, News articles, Company websites, X posts. Not available: LinkedIn (consent needed)')
  assert.deepEqual(row.fix, { kind: 'link', href: '/app/settings#social', label: 'Set up' })
  assert.doesNotMatch(row.detail, /Reddit/, 'a platform this server does not offer is not listed')
  const plain = byId(readinessRows({ profile: null, usage: { has_key: true }, outreach: null, sources: ALL, advanced: null })).sources
  assert.deepEqual([plain.detail, plain.fix], ['a scan can use Web research with your AI key, Web search index, News articles, Company websites', null])
})
