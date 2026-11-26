import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicSectorBody } from '../lib/non-buyer.ts';

test('recognizes public-sector bodies and preserves commercial buyers', () => {
  const cases: Array<{ name: string; input: Parameters<typeof isPublicSectorBody>[0]; expected: boolean }> = [
    { name: 'city', input: { company: 'City of Toronto' }, expected: true },
    { name: 'town', input: { company: 'Town of Oakville' }, expected: true },
    { name: 'county of', input: { company: 'County of Fairfax' }, expected: true },
    { name: 'school board', input: { company: 'Toronto District School Board' }, expected: true },
    { name: 'school district', input: { company: 'North Valley School District' }, expected: true },
    { name: 'department of', input: { company: 'Department of Transportation' }, expected: true },
    { name: 'ministry of', input: { company: 'Ministry of Education' }, expected: true },
    { name: 'police department', input: { company: 'Riverton Police Department' }, expected: true },
    { name: 'fire department', input: { company: 'Riverton Fire Department' }, expected: true },
    { name: '.gov domain', input: { company: 'Office of Civic Services', domain: 'agency.gov' }, expected: true },
    { name: '.gc.ca domain', input: { company: 'Canadian Public Office', domain: 'department.gc.ca' }, expected: true },
    { name: '.mil domain', input: { company: 'Defense Office', domain: 'army.mil' }, expected: true },
    { name: 'government-targeted offer', input: { company: 'City of Toronto', offer: 'Our platform serves government agencies and municipalities.' }, expected: false },
    { name: 'public-sector procurement offer', input: { company: 'Public Health Office', offer: 'Built for public sector procurement.' }, expected: false },
    { name: 'govtech offer', input: { company: 'Town of Oakville', offer: 'Govtech software for SLED/public sector teams.' }, expected: false },
    { name: 'City of Dreams Carpentry', input: { company: 'City of Dreams Carpentry' }, expected: false },
    { name: 'negated public-sector offer', input: { company: 'Northstar Analytics', offer: 'We do not sell to the public sector.' }, expected: false },
    { name: 'commercial school', input: { company: 'School District Consulting LLC' }, expected: false },
    { name: 'commercial library', input: { company: 'Public Library Software Inc.' }, expected: false },
    { name: 'lookalike domain', input: { company: 'Civic Solutions', domain: 'example.gov.com' }, expected: false },
    { name: 'ordinary business', input: { company: 'Northstar Analytics' }, expected: false },
    { name: 'City of Brampton Plumbing Ltd', input: { company: 'City of Brampton Plumbing Ltd' }, expected: false },
    { name: 'Toronto Police Department', input: { company: 'Toronto Police Department' }, expected: true },

    { name: 'Halton District School Board', input: { company: 'Halton District School Board' }, expected: true },
    { name: 'City of Angels Roofing', input: { company: 'City of Angels Roofing' }, expected: false },
    { name: 'City of Brampton Plumbing Ltd', input: { company: 'City of Brampton Plumbing Ltd' }, expected: false },
    { name: 'City of Toronto Council trailing token', input: { company: 'City of Toronto Council' }, expected: false },
    { name: 'Ministry of Health', input: { company: 'Ministry of Health' }, expected: true },
  ];

  for (const { name, input, expected } of cases) {
    const result = isPublicSectorBody(input);
    assert.equal(result.nonBuyer, expected, name);
    assert.equal(typeof result.reason, 'string', `${name}: reason type`);
    assert.ok(result.reason.trim().length > 0, `${name}: reason must be non-empty`);
  }
});
