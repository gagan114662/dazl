import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { emptyLeadsMessage, repeatingSearchesCopy } from '../lib/scan/leads-view.ts'
import { nextAction, type Campaign } from '../lib/outreach/campaigns.ts'
import { currentPlay, journey, type JourneyJob } from '../lib/journey.ts'

// Four page inconsistencies Quest found on production 145d2eba (#1579, #1238).
const leadsPage = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
const homePage = readFileSync(new URL('../app/app/journey.tsx', import.meta.url), 'utf8')

// 1. The bare Leads page said "No leads yet. Run a scan." beside a Past scans list full of leads.
test('Leads with no scan open never says "No leads yet" when past scans hold leads', () => {
  const m = emptyLeadsMessage('', 0, 0, 0, 0, 3)!
  assert.doesNotMatch(m, /No leads yet/)
  assert.match(m, /past scans/i)
  assert.equal(emptyLeadsMessage('', 0, 0, 0, 0, 1), m, 'one past scan with leads is enough')
  // an account with no saved leads at all keeps the line (it is true there), and an open scan keeps its own copy
  assert.equal(emptyLeadsMessage('', 0, 0, 0, 0, 0), 'No leads yet. Run a scan.')
  assert.equal(emptyLeadsMessage('', 0, 0), 'No leads yet. Run a scan.')
  assert.equal(emptyLeadsMessage('done', 0, 0, 0, 0, 3), 'The scan finished with no leads.')
  assert.equal(emptyLeadsMessage('running', 0, 0, 0, 0, 3), 'This scan is still running. Leads appear here when it finishes.')
  // the page passes the past scans that saved leads, and says nothing until that list has been read
  assert.match(leadsPage, /pastJobs\.filter\(j => j\.lead_count > 0\)\.length/)
  assert.match(leadsPage, /!jobId && !pastJobs \? null/)
})

// 2. Campaigns: a search that still has leads that passed sent its next step to a new search (?q=) instead of to its own leads.
const campaign = (q: Partial<Campaign['qualification']>): Omit<Campaign, 'next'> => ({
  id: 'e'.repeat(24), query: 'Dental practices in Ohio - opening a new location', status: 'done', error: null, created_at: 0,
  discovery: { candidates: 7, leads: 7 },
  qualification: { sourceChecked: 0, confirmedByYou: 0, needsReview: 0, research: 0, unverified: 0, held: 0, heldResearch: 0, heldResearchSourceChecked: 0, rejected: 0, heldByChecks: 0, ...q },
  contact: { withContact: 0, readyWithContact: 0, draftable: 0 },
  outreach: { drafts: 0, approved: 0, sent: 0, draftsReady: 0, draftsSetup: 0, draftsHeld: 0, approvedReady: 0, approvedSetup: 0, approvedHeld: 0 },
  sequence: { active: 0, stopped: 0 }, reply: { replied: 0, interested: 0, bounced: 0, optOuts: 0 },
})
test('Campaigns next step: a search with leads that passed opens that search (job_id), never a new search (q)', () => {
  const open = `/app/leads?job_id=${'e'.repeat(24)}`
  // the production shape: 2 source-checked, 5 research only
  const mixed = nextAction(campaign({ sourceChecked: 2, research: 5 }), 0)
  assert.equal(mixed.href, open)
  assert.equal(mixed.label, '5 research-only leads: checking them cannot make them ready. Open the search to see the 2 leads that passed')
  const one = nextAction(campaign({ confirmedByYou: 1, research: 1 }), 0)
  assert.deepEqual(one, { label: '1 research-only lead: checking it cannot make it ready. Open the search to see the 1 lead that passed', href: open })
  // a source-checked lead that is itself held as research has not passed: nothing passed, so the step is still a new search
  const heldOnly = nextAction(campaign({ sourceChecked: 1, held: 1, heldResearch: 1, heldResearchSourceChecked: 1 }), 0)
  assert.match(heldOnly.label, /Change the search$/)
  assert.match(heldOnly.href!, /^\/app\/leads\?q=/)
  // nothing passed: "Change the search" still starts a new search on purpose (#352/#683), unchanged
  const none = nextAction(campaign({ research: 5 }), 0)
  assert.deepEqual(none, { label: '5 research-only leads: checking them cannot make them ready. Change the search', href: `/app/leads?q=${encodeURIComponent('Dental practices in Ohio - opening a new location')}` })
})

// 3. Home's play box showed a repeating play but linked to a later hand-run search of the same sentence, not the play's own last run.
const job = (o: Partial<JourneyJob>): JourneyJob => ({ id: 'a'.repeat(24), status: 'done', error: null, query: 'Dental owners in Ohio', csv_domain: null, created_at: 100, candidates: 3, verified: 1, needs_review: 0, dropped: 0, lead_count: 2, test_only: false, ...o })
test('Home play box uses the play\'s own last run, the run the Plays page links to', () => {
  const RUN = 'b'.repeat(24), MANUAL = 'c'.repeat(24), OTHER = 'd'.repeat(24)
  const jobs = [job({ id: MANUAL, created_at: 300 }), job({ id: RUN, created_at: 200 })]
  const watches = [{ query: ' Dental owners in Ohio ', last_job_id: RUN }]
  assert.equal(currentPlay(jobs)?.id, MANUAL, 'no play list: the newest search, as before')
  assert.equal(currentPlay(jobs, watches)?.id, RUN, 'the play\'s own last run, not the later hand-run search')
  const j = journey({ profile: { sells: 'Booking software' }, jobs, leads: null, drafts: null, watches })
  assert.equal(j.play?.id, RUN)
  assert.equal(j.action?.href, `/app/leads?job_id=${RUN}`)
  // a search that is running now is still what Home shows (its progress and Stop)
  assert.equal(currentPlay([job({ id: MANUAL, created_at: 300, status: 'running' }), job({ id: RUN, created_at: 200 })], watches)?.id, MANUAL)
  // a newest search with a different sentence is not that play: it stays
  assert.equal(currentPlay([job({ id: OTHER, created_at: 400, query: 'Law firms in Texas' }), ...jobs], watches)?.id, OTHER)
  // a play that has not run, or whose last run is not in the list Home read, changes nothing
  assert.equal(currentPlay(jobs, [{ query: 'Dental owners in Ohio', last_job_id: null }])?.id, MANUAL)
  assert.equal(currentPlay(jobs, [{ query: 'Dental owners in Ohio', last_job_id: 'f'.repeat(24) }])?.id, MANUAL)
  assert.equal(currentPlay(jobs, null)?.id, MANUAL)
  // Home passes the plays it read into the journey, and waits for them before it picks the run
  assert.match(homePage, /watches: watches === 'loading' \? null : watches/)
  assert.match(homePage, /watches === 'loading'\) return <div[^>]*data-testid="journey-loading"/)
})

// 4. The account-wide "Repeating searches" list sat on every search's page, right under "Settings for this play", and read as that search's own setting.
test('Leads: the repeating-searches list is labelled as the whole account\'s, on every search\'s page', () => {
  const onSearch = repeatingSearchesCopy(true), bare = repeatingSearchesCopy(false)
  assert.equal(onSearch.heading, 'Your repeating searches (all searches)')
  assert.equal(bare.heading, 'Your repeating searches (all searches)')
  assert.match(onSearch.scope!, /not a setting of the search open on this page/)
  assert.equal(bare.scope, null, 'no search is open on the bare Leads page')
  assert.doesNotMatch(leadsPage, />Repeating searches </, 'the unlabelled heading is gone')
  assert.match(leadsPage, /repeatingSearchesCopy\(!!jobId\)/)
  assert.match(leadsPage, /data-testid="repeating-scope"/)
})
