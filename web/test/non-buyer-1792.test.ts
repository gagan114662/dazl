import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicSectorBody } from '../lib/non-buyer.ts';

test('recognizes public-sector bodies and preserves commercial buyers', () => {
  const cases: Array<{ name: string; input: Parameters<typeof isPublicSectorBody>[0]; expected: boolean }> = [
    { name: 'city', input: { company: 'City of Toronto' }, expected: true },
    { name: 'town', input: { company: 'Town of Oakville' }, expected: true },
    { name: 'county', input: { company: 'County of Fairfax' }, expected: true },
    { name: 'municipality', input: { company: 'Municipality of Halifax' }, expected: true },
    { name: 'borough', input: { company: 'Borough of Queens' }, expected: true },
    { name: 'school board', input: { company: 'Toronto District School Board' }, expected: true },
    { name: 'school district', input: { company: 'North Valley School District' }, expected: true },
    { name: 'public schools', input: { company: 'Springfield Public Schools' }, expected: true },
    { name: 'department of', input: { company: 'Department of Transportation' }, expected: true },
    { name: 'ministry of', input: { company: 'Ministry of Education' }, expected: true },
    { name: 'public library', input: { company: 'Hamilton Public Library' }, expected: true },
    { name: 'public health', input: { company: 'Ottawa Public Health' }, expected: true },
    { name: 'police department', input: { company: 'Riverton Police Department' }, expected: true },
    { name: 'fire department', input: { company: 'Riverton Fire Department' }, expected: true },
    { name: 'housing authority', input: { company: 'Metro Housing Authority' }, expected: true },
    { name: 'transit authority', input: { company: 'Regional Transit Authority' }, expected: true },
    { name: '.gov domain', input: { company: 'Office of Civic Services', domain: 'agency.gov' }, expected: true },
    { name: '.gc.ca domain', input: { company: 'Canadian Public Office', domain: 'department.gc.ca' }, expected: true },
    { name: '.mil domain', input: { company: 'Defense Office', domain: 'army.mil' }, expected: true },
    { name: 'state of', input: { company: 'State of Oregon' }, expected: true },
    { name: 'province of', input: { company: 'Province of Ontario' }, expected: true },
    { name: 'village of', input: { company: 'Village of Westport' }, expected: true },
    { name: 'public agency', input: { company: 'Central Public Agency' }, expected: true },
    { name: 'public works', input: { company: 'City Public Works' }, expected: true },
    { name: 'government-targeted offer', input: { company: 'City of Toronto', offer: 'Our platform serves government agencies and municipalities.' }, expected: false },
    { name: 'public-sector procurement offer', input: { company: 'Public Health Office', offer: 'Built for public sector procurement.' }, expected: false },
    { name: 'govtech offer', input: { company: 'Town of Oakville', offer: 'Govtech software for SLED/public sector teams.' }, expected: false },
    { name: 'City of Dreams Bakery', input: { company: 'City of Dreams Bakery' }, expected: false },
    { name: 'City of Dreams Carpentry', input: { company: 'City of Dreams Carpentry' }, expected: false },
    { name: 'negated public-sector offer', input: { company: 'Northstar Analytics', offer: 'We do not sell to the public sector.' }, expected: false },
    { name: 'commercial school', input: { company: 'School District Consulting LLC' }, expected: false },
    { name: 'commercial library', input: { company: 'Public Library Software Inc.' }, expected: false },
    { name: 'lookalike domain', input: { company: 'Civic Solutions', domain: 'example.gov.com' }, expected: false },
    { name: 'ordinary business', input: { company: 'Northstar Analytics' }, expected: false },
  ];

  for (const { name, input, expected } of cases) {
    const result = isPublicSectorBody(input);
    assert.equal(result.nonBuyer, expected, name);
    assert.equal(typeof result.reason, 'string', `${name}: reason type`);
    assert.ok(result.reason.trim().length > 0, `${name}: reason must be non-empty`);
  }
});
