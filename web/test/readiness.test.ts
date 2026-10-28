import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capNotice, readinessRows, recentPlays } from '../lib/readiness.ts'

const byId = (rows: ReturnType<typeof readinessRows>) => Object.fromEntries(rows.map(r => [r.id, r]))

const job = (o: object = {}) => ({ id: 'j', status: 'done', error: null, query: 'Dentists in Ohio', csv_domain: null, created_at: 1, lead_count: 0, ...o })

test('a new account: the steps in order, each to-do with its fix; Gmail goes to Settings where its consent text is', () => {
  const rows = readinessRows({ profile: { sells: '', website: '' }, usage: { has_key: false, trial: null }, outreach: { gmail: null, sender: null, daily_cap: 20, sent_24h: 0 }, jobs: [], sources: { web_index: false, news: false, websites: false }, messages: [], campaigns: [] })
  const r = byId(rows)
  assert.deepEqual(Object.keys(r), ['site', 'brain', 'key', 'sources', 'play', 'scan', 'review', 'gmail', 'sender', 'approved', 'limit'])
  assert.deepEqual(Object.values(r).map(x => x.state), ['todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'done'])
  assert.deepEqual(rows.filter(x => x.next).map(x => x.id), ['site'], 'exactly one next step: the first to-do')
  assert.deepEqual(r.brain.fix, { kind: 'link', href: '/app?setup=brain', label: 'Build' })
  assert.equal(r.site.label, 'Website and business details', 'business details only: the buyer profile is not checked')
  assert.deepEqual(r.play.fix, { kind: 'link', href: '/app/leads', label: 'Write a play' })
  assert.equal(r.key.detail, 'needed for searches')
  assert.deepEqual(r.gmail.fix, { kind: 'link', href: '/app/settings#gmail', label: 'Connect' })
  assert.deepEqual(r.sender.fix, { kind: 'inline', label: 'Add' })
  assert.equal(r.limit.detail, 'up to 20 emails a day; 0 sent in the last 24 hours')
})

test('a ready account: all done, no fixes offered', () => {
  const r = readinessRows({ profile: { sells: 'Booking software', website: 'https://acme.example', business_name: 'Acme', buyer: { summary: 'Independent dental practices', who: ['Practice owner'] } }, usage: { has_key: true, trial: null }, outreach: { gmail: { email: 'me@acme.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St, Columbus OH' }, daily_cap: 12, sent_24h: 3 }, jobs: [job()], sources: { web_index: true, news: true, websites: true }, messages: [{ status: 'sent' }], campaigns: [{ id: 'j', qualification: { rejected: 0 } }] })
  assert.ok(r.every(x => x.state === 'done' && x.fix === null && !x.next))
  assert.equal(byId(r).sources.detail, 'a scan can use Web research with your AI key, Web search index, News articles, Company websites')
  assert.equal(byId(r).gmail.detail, 'sending from me@acme.example')
  assert.equal(byId(r).site.detail, 'Acme - Booking software (acme.example)')
  assert.equal(byId(r).play.detail, '1 search written')
  assert.equal(byId(r).limit.detail, 'up to 12 emails a day; 3 sent in the last 24 hours')
})

test('a failed status load is "could not check", never done or to-do', () => {
  const r = readinessRows({ profile: null, usage: null, outreach: null, jobs: null, sources: null, messages: null, campaigns: null })
  assert.ok(r.every(x => x.state === 'unknown' && x.fix === null && !x.next))
  assert.ok(r.every(x => /^could not check - .+ did not load$/.test(x.detail)), 'each "?" says what did not load')
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
  const ready = { profile: { sells: 'Booking software', website: 'https://acme.example', business_name: 'Acme', buyer: { summary: 'Dental practices', who: ['Owner'] } }, usage: { has_key: true, trial: null }, jobs: [job()], sources: { web_index: true, news: true, websites: true }, messages: [{ status: 'approved' }], campaigns: [] }
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
// Instinct #275: the evidence (and what clears it) is server-side (test/key-evidence.test.ts). The record never says
// which key a scan used, so Home names none, and never infers acceptance from other scans.
test('AI key: done with no open rejection; a server-reported rejection is a to-do that names no key', () => {
  const key = (keys: object[] | null, rejection: object | null, jobs: object[] = []) => byId(readinessRows({ profile: null, usage: { has_key: true }, outreach: null, keys: keys as never, rejection: rejection as never, jobs: jobs as never })).key
  const K = [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1000 }]
  const K2 = [...K, { vendor: 'openai', last4: 'Zz99', validated_at: 5000 }]
  assert.deepEqual(key(K, null), { id: 'key', label: 'AI key', state: 'done', detail: 'saved (ending Ab12); your provider accepted it when it was saved', fix: null })
  const one = key(K, { error: 'key_rejected' })
  assert.deepEqual([one.state, one.detail, one.fix], ['todo', 'a scan stopped because the AI provider rejected its key, after your key was last saved - save your key again to confirm it works', { kind: 'inline', label: 'Replace key' }])
  assert.equal(key(K2, { error: 'key_rejected' }).detail, 'a scan stopped because the AI provider rejected its key, after your keys were last saved - save each of your keys again to confirm they work')
  assert.equal(key(K, { error: 'key_unreadable' }).detail, 'a scan could not read its AI key after your key was last saved - save your key again to confirm it works')
  for (const k of [K, K2]) assert.doesNotMatch(key(k, { error: 'key_rejected' }).detail, /Anthropic|OpenAI|Ab12|Zz99/, 'no key is named')
  const job = (created_at: number, status: string, error: string | null) => ({ id: String(created_at), status, error, query: 'q', csv_domain: null, created_at, lead_count: 0 })
  assert.equal(key(K, { error: 'key_rejected' }, [job(2000, 'failed', 'key_rejected'), job(3000, 'failed', 'cancelled'), job(4000, 'done', null)]).state, 'todo')
  assert.equal(key(K, null, [job(2000, 'failed', 'key_rejected')]).state, 'done', 'the jobs list alone is not evidence; the server read is')
  assert.equal(key(null, null).detail, 'saved', 'key status not loaded: no claim either way')
  const src = byId(readinessRows({ profile: null, usage: { has_key: true }, outreach: null, keys: K as never, rejection: { error: 'key_rejected' }, sources: { web_index: true, news: true, websites: true } })).sources
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

// The Pancake path after setup: first scan, leads reviewed, an email approved in Outreach. Positive evidence only.
test('first scan, leads reviewed and first approved email: done only on evidence; a failed read is "?", never a check', () => {
  const rows = (o: object) => byId(readinessRows({ profile: null, usage: null, outreach: null, ...o } as never))
  const done = job({ id: 'd1', created_at: 5, verified: 2, needs_review: 1 })
  // First scan.
  assert.deepEqual([rows({ jobs: [] }).scan.state, rows({ jobs: [] }).scan.fix], ['todo', { kind: 'link', href: '/app/leads', label: 'Find leads' }])
  assert.deepEqual([rows({ jobs: [job({ status: 'running' })] }).scan.detail, rows({ jobs: [job({ status: 'running' })] }).scan.fix?.label], ['running now', 'See progress'])
  assert.equal(rows({ jobs: [job({ status: 'failed', error: 'no_candidates' })] }).scan.state, 'todo', 'a failed scan is not a finished one')
  assert.deepEqual([rows({ jobs: [done] }).scan.state, rows({ jobs: [done] }).scan.detail], ['done', '1 finished; latest: 2 source-checked, 1 needs your review'])
  // Leads reviewed.
  assert.deepEqual([rows({ jobs: [done], messages: [], campaigns: [{ id: 'd1', qualification: { rejected: 0 } }] }).review.state, rows({ jobs: [done], messages: [], campaigns: [] }).review.fix], ['todo', { kind: 'link', href: '/app/leads?job_id=d1', label: 'Review leads' }])
  assert.equal(rows({ messages: [{ status: 'draft' }], campaigns: [] }).review.detail, 'leads approved into drafts')
  assert.equal(rows({ messages: [], campaigns: [{ id: 'x', qualification: { rejected: 2 } }] }).review.detail, 'leads approved into drafts or rejected (2 rejected)')
  assert.equal(rows({ messages: [{ status: 'skipped' }], campaigns: [] }).review.state, 'todo', 'a skipped email is not an approval')
  assert.deepEqual([rows({ messages: null, campaigns: [] }).review.state, rows({ messages: null, campaigns: [] }).review.detail], ['unknown', 'could not check - your emails did not load'])
  assert.equal(rows({ messages: null, campaigns: [{ id: 'x', qualification: { rejected: 1 } }] }).review.state, 'done', 'positive evidence from the read that worked')
  // Instinct #285: a capped list is not complete history. 200 emails (the read's cap) with none from a lead, or 10
  // campaigns (its cap) without a rejection, prove nothing: "?", not a to-do.
  const capped = Array.from({ length: 200 }, () => ({ status: 'skipped' }))
  assert.deepEqual([rows({ messages: capped, campaigns: [] }).review.state, rows({ messages: capped, campaigns: [] }).review.detail], ['unknown', 'could not check - only your latest 200 emails could be checked'])
  const tenCamps = Array.from({ length: 10 }, (_, k) => ({ id: String(k), qualification: { rejected: 0 }, outreach: { drafts: 0, approved: 0, sent: 0 } }))
  assert.equal(rows({ messages: [], campaigns: tenCamps }).review.detail, 'could not check - only your latest 10 searches could be checked')
  assert.equal(rows({ messages: capped, campaigns: [{ id: 'x', qualification: { rejected: 0 }, outreach: { drafts: 1, approved: 0, sent: 0 } }] }).review.state, 'done', 'a complete per-scan count proves it')
  // First email approved in Outreach.
  assert.deepEqual([rows({ messages: [{ status: 'draft' }] }).approved.state, rows({ messages: [{ status: 'draft' }] }).approved.detail], ['todo', 'a draft is waiting for your review'])
  assert.equal(rows({ messages: [{ status: 'sent' }] }).approved.detail, 'an email approved or sent')
  assert.equal(rows({ messages: null }).approved.state, 'unknown')
  assert.deepEqual([rows({ messages: capped }).approved.state, rows({ messages: capped }).approved.detail], ['unknown', 'could not check - only your latest 200 emails could be checked'])
  assert.equal(rows({ messages: capped, campaigns: [{ id: 'x', qualification: { rejected: 0 }, outreach: { drafts: 0, approved: 1, sent: 0 } }] }).approved.state, 'done', 'an older approved email found through its campaign')
})

// Instinct #288: the jobs list is the newest 20. Twenty recent failures can hide an older finished scan and an older play.
test('first play and first scan never claim absence from a full newest-20 list; complete totals decide', () => {
  const rows = (o: object) => byId(readinessRows({ profile: null, usage: null, outreach: null, ...o } as never))
  const failed = Array.from({ length: 20 }, (_, k) => job({ id: `f${k}`, created_at: 100 + k, status: 'failed', error: 'upstream 502' }))
  // With complete totals: an older finished scan (not in the list) counts.
  const withTotals = rows({ jobs: failed, totals: { searches: 21, finished: 1 } })
  assert.deepEqual([withTotals.scan.state, withTotals.scan.detail], ['done', '1 finished'])
  assert.equal(withTotals.play.state, 'done')
  assert.deepEqual([rows({ jobs: failed, totals: { searches: 20, finished: 0 } }).scan.state, rows({ jobs: failed, totals: { searches: 20, finished: 0 } }).scan.detail], ['todo', 'no scan has finished yet'], 'complete totals can prove absence')
  // Without totals, a full list proves nothing: "?", never "no scan has finished yet".
  const noTotals = rows({ jobs: failed })
  assert.deepEqual([noTotals.scan.state, noTotals.scan.detail], ['unknown', 'could not check - only your latest 20 scans could be checked'])
  assert.notEqual(noTotals.scan.detail, 'no scan has finished yet')
  // Twenty imports (not plays) fill the list: an older play is not ruled out.
  const imports = Array.from({ length: 20 }, (_, k) => job({ id: `i${k}`, csv_domain: 'acme.com', created_at: k }))
  assert.equal(rows({ jobs: imports }).play.state, 'unknown')
  assert.equal(rows({ jobs: imports, totals: { searches: 1, finished: 1 } }).play.detail, '1 search written')
  assert.equal(rows({ jobs: imports, totals: { searches: 0, finished: 0 } }).play.state, 'todo')
  // A short list is complete: absence there is real.
  assert.equal(rows({ jobs: failed.slice(0, 3) }).scan.detail, 'no scan has finished yet')
})
