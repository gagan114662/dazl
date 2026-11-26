import test from 'node:test';
import assert from 'node:assert/strict';
import { findJobBankEmployerSite } from '../lib/discover/jobbank-employer-site.ts';

// Trimmed excerpts from real Job Bank postings; employer identity and external-link region only.
const toothCorner = `<p>Employer details <strong>The Tooth Corner</strong></p><a href="https://ca.indeed.com/viewjob?id=example">View the full job posting on indeed.com</a>`;
const northStar = `<p>Employer details <strong>North Star Dentistry</strong></p><a href="https://ca.indeed.com/viewjob?id=example">View the full job posting on indeed.com</a>`;
const mhmi = `<p>Employer details <strong>MHMI</strong></p><a href="https://www.careerbeacon.com/en/job/4024800/mhmi">View the full job posting on CareerBeacon</a>`;

test('real Job Bank posting without website returns null (The Tooth Corner)', () => assert.equal(findJobBankEmployerSite(toothCorner), null));
test('real Job Bank posting without website returns null (North Star Dentistry)', () => assert.equal(findJobBankEmployerSite(northStar), null));
test('real Job Bank posting without website returns null (MHMI)', () => assert.equal(findJobBankEmployerSite(mhmi), null));
test('employer Website field returns bare host', () => assert.equal(findJobBankEmployerSite('<div>Website: <a href="https://www.Example.ca/path">www.Example.ca</a></div>'), 'example.ca'));
test('employer body link returns bare host', () => assert.equal(findJobBankEmployerSite('<p>Visit our website <a href="https://clinic.example.ca/about">here</a></p>'), 'clinic.example.ca'));
test('aggregator only is rejected', () => assert.equal(findJobBankEmployerSite('<a href="https://linkedin.com/company/acme">Website</a>'), null));
test('free-mail only is rejected', () => assert.equal(findJobBankEmployerSite('<div>Website: mailto:clinic@gmail.com</div>'), null));
test('Job Bank hosts are rejected', () => assert.equal(findJobBankEmployerSite('<div>Website: https://on.jobbank.gc.ca/path</div>'), null));
test('messy URL normalizes', () => assert.equal(findJobBankEmployerSite('<div>Website:  WWW.Example.ca./path?q=1 </div>'), 'example.ca'));
test('domain-looking employer name is not guessed', () => assert.equal(findJobBankEmployerSite('<strong>Example.ca Dentistry</strong>'), null));
