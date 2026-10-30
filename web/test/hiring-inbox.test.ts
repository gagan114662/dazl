// #461: a careers@ / recruiting inbox is never kept as a verified lead's sales contact. Synthetic company and addresses; no network, no sends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHiringInbox } from '../lib/outreach/hiring-inbox.ts'
import { verifyEvidence } from '../lib/scan/evidence.ts'
import { verifyLeads } from '../lib/scan/runner.ts'
import { classifyPurpose, publishedEmail } from '../lib/outreach/published-email.ts'
import { NOT_A_FOUNDER_ROUTE } from '../lib/scan/actionable.ts'

test('hiring inboxes are recognized on the whole local part; look-alikes are not', () => {
  for (const e of ['careers@x.example', 'Careers@X.example', 'career@x.example', 'jobs@x.example', 'recruiting@x.example', 'recruitment@x.example', 'recruiter@x.example', 'talent@x.example', 'hr@x.example', 'hiring@x.example',
    'apply@x.example', 'applications@x.example', 'cv@x.example', 'resume@x.example', 'join-us@x.example', 'join.us@x.example', 'join_us@x.example', 'work-with-us@x.example', 'careers+toronto@x.example', 'human.resources@x.example']) assert.equal(isHiringInbox(e), true, e)
  for (const e of ['hello@x.example', 'sales@x.example', 'jane.doe@x.example', 'jobsworth@x.example', 'hrishi@x.example', 'applegate@x.example', 'careersoft@x.example', 'cvetkovic@x.example', 'joinery@x.example', 'info@x.example', 'x', '', null, undefined, '@x.example']) assert.equal(isHiringInbox(e as never), false, String(e))
})

const NOW = new Date('2026-10-20T12:00:00Z')
const PAGE_TEXT = '2026-10-12. Lakeshore Creative, a Toronto marketing agency, opened a new office in Liberty Village, Toronto, ON this month and is hiring designers. Apply: careers@lakeshore.example. Questions about the new studio: hello@lakeshore.example. ' + 'The agency serves clients across the city. '.repeat(6)
const cand = (o: object = {}) => ({ name: '', company: 'Lakeshore Creative', contact: 'careers@lakeshore.example' as string | null, signal: 'opened a new office', source_url: 'https://news.example/toronto/lakeshore-creative', score: 70,
  excerpt: 'Lakeshore Creative, a Toronto marketing agency, opened a new office in Liberty Village, Toronto, ON this month', event_date: '2026-10-12' as string | null, ...o })
const page = { text: PAGE_TEXT, title: 'Lakeshore Creative opens', retrievedAt: 1_800_000_000 }

test('#461 case: the lead stays verified on its genuine dated event, but the careers@ contact is dropped', () => {
  const v = verifyEvidence(cand(), page, NOW)
  assert.equal(v.ok, true); if (v.ok) { assert.equal(v.contact, null); assert.equal(v.dateStatus, 'unverified') }
})

test('look-alikes and real sales routes on the same page are kept exactly as before', () => {
  for (const c of ['hello@lakeshore.example', 'jobsworth@lakeshore.example']) {
    const text = PAGE_TEXT + ` Reach ${c} for press.`
    const v = verifyEvidence(cand({ contact: c }), { ...page, text }, NOW)
    assert.equal(v.ok && v.contact, c)
  }
})

test('through the production verifier (verifyLeads): Lakeshore stays a verified lead with no contact; the sales address is kept for a lead that names it', async () => {
  const fetch = async () => page
  const r = await verifyLeads([cand()], fetch, NOW)
  assert.equal(r.leads.length, 1); assert.equal(r.leads[0].contact, null); assert.equal(r.leads[0].event_date, '2026-10-12')
  const keep = await verifyLeads([cand({ contact: 'hello@lakeshore.example' })], fetch, NOW)
  assert.equal(keep.leads[0].contact, 'hello@lakeshore.example')
})

test('drafting and the contact sweeps agree: a hiring inbox is a non-sales route everywhere', () => {
  for (const e of ['careers@lakeshore.example', 'apply@lakeshore.example', 'join-us@lakeshore.example', 'cv@lakeshore.example']) {
    assert.equal(classifyPurpose(e).purpose, 'non-sales', e)
    assert.equal(publishedEmail({ contact: e, source_url: 'https://lakeshore.example/x' }), null, e)
    assert.equal(NOT_A_FOUNDER_ROUTE.test(e.split('@')[0].replace(/[._-]/g, '')), true, e)
  }
  for (const e of ['hello@lakeshore.example', 'jobsworth@lakeshore.example', 'hrishi@lakeshore.example']) {
    assert.notEqual(classifyPurpose(e).purpose, 'non-sales', e)
    assert.equal(NOT_A_FOUNDER_ROUTE.test(e.split('@')[0].replace(/[._-]/g, '')), false, e)
  }
})
