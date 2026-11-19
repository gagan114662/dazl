// #377 (Hermes live finding): a fit rationale on a lead without proof-backed timing must not carry model
// timing claims ("the hiring trigger is live", "currently", "recently", "now"). Fit reasoning survives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitRationale } from '../lib/scan/score.ts'

const LIVE = 'Queen Street Dental Centre is a dental clinic in Toronto hiring a dental receptionist (front-desk staff per ICP). The hiring trigger is live based on the job posting evidence. Lead with their receptionist hiring as a prompt.'

test('#377 unproven timing: an explicitly live trigger suppresses related claims across the rationale', () => {
  assert.equal(fitRationale(LIVE, 'unconfirmed'), null)
})

test('#377 unproven timing: currently / recently / now / just assertions suppress mixed prose', () => {
  for (const s of ['They are currently hiring SDRs.', 'They recently raised a Series A.', 'They need a CRM now.', 'The company just opened a second office.', 'This is a timely moment to reach out.']) {
    const out = fitRationale(`Acme sells B2B software to dentists. ${s}`, 'unconfirmed')
    assert.equal(out, null, s)
  }
})

test('#377 unproven timing: rationale made only of timing claims gives null', () => {
  assert.equal(fitRationale('The hiring trigger is live based on the job posting evidence.', 'unconfirmed'), null)
})

test('#377 proof-backed timing keeps the model wording unchanged', () => {
  assert.equal(fitRationale(LIVE, 'proof_backed'), LIVE)
})


test('#377 neutral fit stays intact across geographies and sectors', () => {
  for (const fit of [
    'The Utrecht logistics supplier provides refrigerated storage.',
    'The Auckland roofing contractor handles commercial roofs.',
    'The Montreal accountant specializes in inventory finance.',
  ]) {
    assert.equal(fitRationale(fit, 'unconfirmed'), fit)
  }
  const neutral = 'The buyer needs not just a starter plan but regional coverage.'
  assert.equal(fitRationale(neutral, 'unconfirmed'), neutral)
})

test('#377 a separate urgency sentence invalidates the whole held rationale', () => {
  for (const rationale of [
    'Acme fits dental clinics. The hiring campaign is live. Reach out ASAP.',
    'Acme fits dental clinics. The hiring campaign is live.',
    'Acme fits dental clinics. The hiring campaign is accepting applications. Reach out ASAP.',
  ]) assert.equal(fitRationale(rationale, 'unconfirmed'), null)
})
