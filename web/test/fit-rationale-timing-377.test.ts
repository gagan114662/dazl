// #377 (Hermes live finding): a fit rationale on a lead without proof-backed timing must not carry model
// timing claims ("the hiring trigger is live", "currently", "recently", "now"). Fit reasoning survives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitRationale } from '../lib/scan/score.ts'

const LIVE = 'Queen Street Dental Centre is a dental clinic in Toronto hiring a dental receptionist (front-desk staff per ICP). The hiring trigger is live based on the job posting evidence. Lead with their receptionist hiring as a prompt.'

test('#377 unproven timing: the "trigger is live" sentence is stripped, fit reasoning kept', () => {
  const out = fitRationale(LIVE, 'unconfirmed')
  assert.ok(out, 'fit reasoning must survive')
  assert.doesNotMatch(out!, /trigger is live/i)
  assert.match(out!, /dental clinic in Toronto/)
  assert.match(out!, /Lead with their receptionist hiring/)
})

test('#377 unproven timing: currently / recently / now / just sentences are dropped', () => {
  for (const s of ['They are currently hiring SDRs.', 'They recently raised a Series A.', 'They need a CRM now.', 'The company just opened a second office.', 'This is a timely moment to reach out.']) {
    const out = fitRationale(`Acme sells B2B software to dentists. ${s}`, 'unconfirmed')
    assert.equal(out, 'Acme sells B2B software to dentists.', s)
  }
})

test('#377 unproven timing: rationale made only of timing claims gives null', () => {
  assert.equal(fitRationale('The hiring trigger is live based on the job posting evidence.', 'unconfirmed'), null)
})

test('#377 proof-backed timing keeps the model wording unchanged', () => {
  assert.equal(fitRationale(LIVE, 'proof_backed'), LIVE)
})
