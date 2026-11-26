import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trialCopy, trialRefusalNotice, TRIAL_REFUSAL_COPY, type TrialBlock } from '../lib/trial-copy.ts'

// #1728 (copy remainder): the domain_used refusal must not call the domain a company - the domain can be a
// throwaway or a shared mail domain, not the user's company. Every surface that words this refusal says the
// same neutral sentence, and the step it offers is the plan link, with no key or BYOK wording anywhere (#1703).
const t = (o: Partial<TrialBlock>): TrialBlock => ({ funded: false, remaining: 0, cap: 3, blocked: null, ...o })
const NEUTRAL = 'Another account with your email domain already used the free searches.'

test('#1728: the domain_used refusal never says company, on any surface', () => {
  const c = trialCopy(t({ blocked: 'domain_used', remaining: 3 }))
  assert.equal(c.text, NEUTRAL)
  assert.doesNotMatch(c.text, /company/i)
  assert.equal(TRIAL_REFUSAL_COPY.domain_used.text, NEUTRAL)
  assert.doesNotMatch(TRIAL_REFUSAL_COPY.domain_used.text, /company/i)
  const notice = trialRefusalNotice('domain_used', '/app/leads', null)
  assert.equal(notice.text, NEUTRAL)
  assert.doesNotMatch(notice.text, /company/i)
})

test('#1728: the domain_used next step is the plan link, with no key wording', () => {
  const c = trialCopy(t({ blocked: 'domain_used', remaining: 3 }))
  assert.deepEqual([c.next.label, c.next.href], ['See your plan', '/app/settings#plan'])
  assert.doesNotMatch(`${c.text} ${c.next.label} ${c.next.href}`, /key|byok/i)
  assert.doesNotMatch(`${TRIAL_REFUSAL_COPY.domain_used.text}`, /key|byok/i)
})
