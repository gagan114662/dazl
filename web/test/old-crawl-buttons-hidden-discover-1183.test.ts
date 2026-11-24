// #1183 (Quest, 2026-11-23): on a lead from the new engine the card still offered "Find contact", "Look for a published contact on the
// company website" and "Find work email". Those run the OLDER engine's site crawl:
//   Find contact / Look for a published contact  -> POST /api/leads/[lead]/find-contact -> lib/scan/find-contact.ts
//                                                   findContactForConfirmedLead -> connectors/sitecrawl.ts crawlJob
//   Find work email (decided lead and review lane) -> POST /api/leads/[lead]/work-email -> lib/people/work-email.ts findWorkEmail,
//                                                   which reads the people and addresses that crawl stored (connector 'sitecrawl')
// and that crawl can store a job title as a person. For launch the buttons are not offered on a discovery lead; the routes stay, and
// every other lead keeps its buttons.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as eligible from '../lib/scan/find-contact-eligible.ts'
import * as workEmail from '../lib/people/work-email-eligible.ts'
import { reviewLaneWorkEmailTargets } from '../lib/people/work-email-review-lane.ts'

const NOW = Date.parse('2026-11-23T18:40:00Z')
const row = (kind: string, value: string, over: Record<string, unknown> = {}) => ({ connector: 'sitecrawl', kind, value, label: null as string | null, source_url: 'https://www.northwind.example/team/', source_date: '2026-11-23', retrieved_at: Math.floor(NOW / 1000), confidence: null, ...over })
const settled = row('domain', 'northwind.example|evidence_own_domain', { label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://www.northwind.example/' })
const lead = (source_kind: string) => ({ id: 'a1'.repeat(12), contact: null, company: 'Northwind', quarantined_at: null, source_kind, human_confirmed_from: null, review_reason: 'source_review_required',
  enrichments: [settled, row('person', 'Jordan Hammond, Chief Marketing Officer')] })

test('#1183 the old-crawl buttons are not offered on a discovery lead; every other lead keeps them', () => {
  const findContactOffered = (eligible as Record<string, unknown>).findContactOffered as ((l: unknown) => boolean) | undefined
  const workEmailOffered = (workEmail as Record<string, unknown>).workEmailOffered as ((l: unknown) => boolean) | undefined
  assert.equal(typeof findContactOffered, 'function', 'lib/scan/find-contact-eligible.ts exports findContactOffered')
  assert.equal(typeof workEmailOffered, 'function', 'lib/people/work-email-eligible.ts exports workEmailOffered')
  assert.deepEqual([findContactOffered!(lead('discover')), workEmailOffered!(lead('discover'))], [false, false])
  assert.deepEqual(reviewLaneWorkEmailTargets(lead('discover'), 'Chief Marketing Officer', NOW), [], 'no Find work email block in the review lane')
  // unchanged for the older engine's leads
  for (const kind of ['query', 'upload', 'company_first']) {
    assert.deepEqual([findContactOffered!(lead(kind)), workEmailOffered!(lead(kind))], [true, true], kind)
    assert.equal(reviewLaneWorkEmailTargets(lead(kind), 'Chief Marketing Officer', NOW).length, 1, kind)
  }
  // and the rules the server routes read are unchanged: the routes stay as they are
  assert.deepEqual([eligible.companySearchEligible(lead('discover')), workEmail.workEmailLeadEligible(lead('discover'))], [true, true])
  assert.deepEqual([workEmailOffered!({ source_kind: 'test', company: workEmail.WORK_EMAIL_FIXTURE_COMPANY }), findContactOffered!({ source_kind: 'test', company: 'x' })], [true, false], 'the fixture rule is as before')
})

test('#1183 the Leads page asks those rules at each of the three buttons', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const before = (marker: string, n = 400) => { const i = src.indexOf(marker); assert.ok(i > 0, marker); return src.slice(Math.max(0, i - n), i) }
  assert.match(before('data-testid="lead-person-find">Find contact</button>'), /findContactOffered\(l\) && <> · <button/)
  assert.match(before('>Look for a published contact on the company website</button>'), /findContactOffered\(l\) && \(\s*<span[^>]*><button onClick=\{\(\) => findContact\(l\.id\)\}/)
  assert.match(before('const site = identityOf({ id: l.id, contact: l.contact }, l.enrichments)\n                    if (!siteSettled(site)) return null', 200), /\{!l\.quarantined_at && workEmailOffered\(l\) && \(\(\) => \{/)
  // no button is rendered from the bare eligibility rule any more
  assert.equal(/companySearchEligible\(l\) && (?:<>|\()/.test(src), false)
  assert.equal(/workEmailLeadEligible\(l\) && \(/.test(src), false)
})
