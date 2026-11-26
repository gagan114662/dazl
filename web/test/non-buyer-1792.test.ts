import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicSectorBody } from '../lib/non-buyer.ts';

test('recognizes public-sector bodies and preserves commercial buyers', () => {
  const cases: Array<{ name: string; input: Parameters<typeof isPublicSectorBody>[0]; expected: boolean }> = [
    { name: 'city', input: { company: 'City of Toronto' }, expected: true },
    { name: 'town', input: { company: 'Town of Oakville', domain: 'oakville.ca' }, expected: true },
    { name: 'county', input: { company: 'County of Fairfax' }, expected: true },
    { name: 'municipality', input: { company: 'Municipality of Halifax' }, expected: true },
    { name: 'regional municipality', input: { company: 'Regional Municipality of Halton' }, expected: true },
    { name: 'township', input: { company: 'Township of King' }, expected: true },
    { name: 'county suffix', input: { company: 'Prince Edward County' }, expected: true },
    { name: 'council suffix', input: { company: 'Newport City Council' }, expected: true },
    { name: 'multiword town without domain', input: { company: 'Town of Halton Hills' }, expected: true },
    { name: 'official city council', input: { company: 'City of Toronto Council' }, expected: true },
    { name: 'multiword civic name', input: { company: 'City of New Westminster', domain: 'newwestminster.ca' }, expected: true },
    { name: 'provincial government domain', input: { company: 'Ministry of Education', domain: 'edu.ontario.ca' }, expected: true },
    { name: 'federal government domain', input: { company: 'Government of Canada', domain: 'canada.ca' }, expected: true },
    { name: 'borough', input: { company: 'Borough of Queens' }, expected: true },
    { name: 'school board', input: { company: 'Toronto District School Board' }, expected: true },
    { name: 'school district', input: { company: 'North Valley School District' }, expected: true },
    { name: 'public schools', input: { company: 'Springfield Public Schools' }, expected: true },
    { name: 'department of', input: { company: 'Department of Transportation', domain: 'transport.gov' }, expected: true },
    { name: 'ministry of', input: { company: 'Ministry of Education', domain: 'education.gov.uk' }, expected: true },
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
    { name: 'Orange County Dental', input: { company: 'Orange County Dental' }, expected: false },
    { name: 'Ministry of Supply', input: { company: 'Ministry of Supply' }, expected: false },
    { name: 'State of Mind Coffee', input: { company: 'State of Mind Coffee' }, expected: false },
    { name: 'Village of Yorkville Dental', input: { company: 'Village of Yorkville Dental' }, expected: false },
    { name: 'Prince Edward County Winery', input: { company: 'Prince Edward County Winery' }, expected: false },
    { name: 'Department of Brand', input: { company: 'Department of Brand' }, expected: false },
    { name: 'Government of Tomorrow', input: { company: 'Government of Tomorrow' }, expected: false },
    { name: 'public audience excluded', input: { company: 'City of Toronto', offer: 'No public sector customers; we only sell to private companies.' }, expected: true },
    { name: 'unrelated exclusion', input: { company: 'City of Toronto', offer: 'We do not serve hospitals. Our platform serves government agencies.' }, expected: false },
    { name: 'municipal buyers targeted', input: { company: 'Town of Oakville', offer: 'Our platform is built for municipalities.' }, expected: false },
    { name: 'government domain with commercial wording', input: { company: 'Department of Education Software', domain: 'education.gov' }, expected: true },
    { name: 'ordinary business', input: { company: 'Northstar Analytics' }, expected: false },
  ];

  for (const { name, input, expected } of cases) {
    const result = isPublicSectorBody(input);
    assert.equal(result.nonBuyer, expected, name);
    assert.equal(typeof result.reason, 'string', `${name}: reason type`);
    assert.ok(result.reason.trim().length > 0, `${name}: reason must be non-empty`);
  }
});

test('hospitals and health authorities are public-sector bodies for private-sector offers', () => {
  const offer = 'Accounting software for private companies';
  for (const company of ['Hamilton General Hospital', 'North Valley Health Authority']) {
    assert.equal(isPublicSectorBody({ company, domain: 'hhsc.ca', offer }).nonBuyer, true, company);
    assert.equal(isPublicSectorBody({ company, offer: 'Software for public sector procurement' }).nonBuyer, false, company);
  }
  assert.equal(isPublicSectorBody({ company: 'North Valley Hospital Supplies', offer }).nonBuyer, false);
});
