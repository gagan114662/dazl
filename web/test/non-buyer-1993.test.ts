import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicSectorBody } from '../lib/non-buyer.ts';

const offer = 'Accounting software for private companies';

for (const company of [
  'VCA Animal Hospital',
  'Toronto Veterinary Hospital',
  'Pet Hospital',
  'The Laptop Hospital',
  'Phone Hospital',
  'Shouldice Hospital',
]) {
  test(`#1993: ${company} stays eligible as a buyer`, () => {
    const sourceText = company === 'Shouldice Hospital' ? 'Shouldice Hospital is a privately owned hospital.' : undefined;
    const verdict = isPublicSectorBody({ company, offer, sourceText });
    assert.equal(verdict.nonBuyer, false);
    assert.equal(verdict.ownershipUnconfirmed, undefined);
  });
}

test('#1993: clear public hospital and health organization signals remain holds', () => {
  for (const input of [
    { company: 'Hamilton General Hospital' },
    { company: 'North Valley Regional Hospital' },
    { company: 'Hamilton Health Sciences' },
    { company: 'North Valley Health Authority' },
    { company: 'North Valley Health Network' },
    { company: 'North Valley Health Services' },
    { company: 'North Valley Health Region' },
    { company: 'North Valley LHIN' },
    { company: 'North Valley Hospital', domain: 'hospital.region.on.ca' },
    { company: 'North Valley Hospital', domain: 'hospital.gc.ca' },
    { company: 'North Valley Hospital', domain: 'hospital.gov' },
  ]) {
    assert.equal(isPublicSectorBody({ ...input, offer }).nonBuyer, true, input.company);
  }
});

test('#1993: a bare hospital name retains an unknown ownership verdict', () => {
  const verdict = isPublicSectorBody({ company: 'Oakville Hospital', offer });
  assert.equal(verdict.nonBuyer, false);
  assert.equal(verdict.ownershipUnconfirmed, true);
});
