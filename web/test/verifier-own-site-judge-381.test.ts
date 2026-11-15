// #381: two verifier drops measured on real sydney-agencies / bangalore-manufacturing scans (14 Nov).
//  1. entity_mismatch on the company's OWN site: Garner Collective's service page (title "B2B Lead Generation Agency Sydney | Garner") speaks
//     in the first person and never repeats the full name. A first-person passage on a host whose label is the company's full name (no spaces)
//     now speaks for the company. Everything else about the entity rule is unchanged (a rival's or client's story on an own site still fails).
//  2. 'contradicts' from the judge dropped leads whose passage states the claim (Krones' plant near Bengaluru, Bayer's MoU). The judge prompt
//     now defines contradicts as a stated conflict only and tells it to ignore dates (the date rules check them). Its effect on the real
//     claim/passage pairs is measured by replay in the PR (the judge is a model; a unit test can only pin the instruction).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companyKey, ownSiteNamed, verifyEvidence, type Candidate } from '../lib/scan/evidence.ts'
import { judgePrompt, parseJudgement } from '../lib/scan/runner.ts'

const NOW = new Date('2026-11-14T12:00:00Z')
// the real passage and title, as on garnercollective.com.au on 14 Nov 2026
const GARNER_PASSAGE = 'We can explore whether targeted lead generation, cold calling or appointment setting is the right next step for your business.'
const page = (text: string, title: string) => ({ text, title, retrievedAt: 1_800_000_000 })
const cand = (o: Partial<Candidate>): Candidate => ({ name: '', company: 'Garner Collective', contact: null, signal: 'Sydney B2B lead generation agency posting about outbound', source_url: 'https://garnercollective.com.au/services/b2b-lead-generation-sydney', score: 70, excerpt: GARNER_PASSAGE, event_date: null, ...o })
const GARNER_PAGE = page(`Free strategy call. ${GARNER_PASSAGE} Talk to our Sydney team.`, 'B2B Lead Generation Agency Sydney | Garner')

test('#381 a first-person passage on the company own site (host = its full name) passes the entity check', () => {
  const v = verifyEvidence(cand({}), GARNER_PAGE, NOW)
  assert.notDeepEqual(v, { ok: false, reason: 'entity_mismatch' })
  assert.equal(v.ok, true, JSON.stringify(v))
})

test('#381 the own-site rule stays strict: another host, a partial or longer name, a third-person passage, or a short name never pass', () => {
  const mismatch = { ok: false, reason: 'entity_mismatch' }
  // the same passage on someone else's site
  assert.deepEqual(verifyEvidence(cand({ source_url: 'https://directory.example/garner-collective' }), page(GARNER_PAGE.text, 'Agency directory'), NOW), mismatch)
  // a host that is only part of the name, or the name plus more
  assert.deepEqual(verifyEvidence(cand({ source_url: 'https://garner.com.au/x' }), GARNER_PAGE, NOW), mismatch)
  assert.deepEqual(verifyEvidence(cand({ source_url: 'https://garnercollectiveagency.com/x' }), GARNER_PAGE, NOW), mismatch)
  // on its own site, a passage about ANOTHER company (no first person) is still that company's news, not this one's
  const other = 'Southside Roofing opened a second yard and is hiring five roofers this month'
  assert.deepEqual(verifyEvidence(cand({ excerpt: other }), page(`${other}. More news.`, 'News | Garner'), NOW), mismatch)
  // a client's story told on an agency's site: the host is the agency's, not the client's
  assert.deepEqual(verifyEvidence(cand({ company: 'Updapt', source_url: 'https://garnercollective.com.au/projects/updapt' }), GARNER_PAGE, NOW), mismatch)
  // the host label check itself
  assert.equal(ownSiteNamed('https://blog.garnercollective.com.au/a', companyKey('Garner Collective')), true, 'a subdomain of the own site')
  assert.equal(ownSiteNamed('https://acme.co.uk/a', companyKey('Acme Ltd')), true, 'legal suffix dropped, second-level suffix skipped')
  assert.equal(ownSiteNamed('https://ibm.com/a', companyKey('IBM')), false, 'under 4 letters: too short to be an identity')
  assert.equal(ownSiteNamed('https://x.com/acmecorp', companyKey('Acme Corp')), false, 'a path on a platform is not the company host')
  assert.equal(ownSiteNamed('not a url', companyKey('Garner Collective')), false)
})

test('#381 the judge prompt defines contradicts as a stated conflict only and tells the judge to ignore dates; the answer parser is unchanged', () => {
  const p = judgePrompt({ company: 'Krones', signal: 'Krones inaugurated a Rs 315 crore plant near Bengaluru in August 2026' }, 'krones opens rs 315 crore bottling machinery plant near bengaluru')
  assert.match(p, /Ignore any date, month or time in the claim: dates are checked separately/)
  assert.match(p, /contradicts: ONLY when the passage states something that cannot be true together with the claim/)
  assert.match(p, /A detail the passage simply does not mention is never a contradiction/)
  assert.match(p, /Reply with exactly one word: supports, contradicts, or unclear\.$/)
  assert.deepEqual(['supports', 'Contradicts.', 'unclear', 'maybe'].map(parseJudgement), ['supports', 'contradicts', 'unclear', 'unclear'])
})
