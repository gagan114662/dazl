// The draft button must appear exactly when the backend can create a draft:
// an address published on the cited page, or a sitecrawl role address from the
// company's own site. Anything else must not offer a draft it would reject.
import test from 'node:test'
import assert from 'node:assert/strict'
import { publishedEmail, publishedContact, classifyPurpose } from '../lib/outreach/published-email.ts'

test('lead.contact wins when it is an email address', () => {
  assert.equal(publishedEmail({ contact: 'sales@acme.com' }), 'sales@acme.com')
})

test('a phone in contact does not qualify, and does not hide a sitecrawl email', () => {
  assert.equal(publishedEmail({ contact: '+1 310 693 8200', enrichments: [{ connector: 'sitecrawl', kind: 'email', value: 'info@acme.com' }] }), 'info@acme.com')
  assert.equal(publishedEmail({ contact: '+1 310 693 8200' }), null)
})

test('only sitecrawl email enrichments qualify - phones, tech and other connectors do not', () => {
  assert.equal(publishedEmail({ contact: null, enrichments: [{ connector: 'sitecrawl', kind: 'phone', value: '+1 800 664 9073' }] }), null)
  assert.equal(publishedEmail({ contact: null, enrichments: [{ connector: 'enrich:apollo', kind: 'contact', value: 'Jane - VP Sales' }] }), null)
  assert.equal(publishedEmail({ contact: null, enrichments: [{ connector: 'hunter', kind: 'email', value: 'jane@acme.com' }] }), null)
})

test('no contact and no enrichments means no draft', () => {
  assert.equal(publishedEmail({ contact: null }), null)
  assert.equal(publishedEmail({ contact: null, enrichments: [] }), null)
})

test('purpose: press, support, privacy, careers and security inboxes are not sales contacts', () => {
  for (const bad of ['press@figma.com', 'support@acme.com', 'privacy@acme.com', 'jobs@acme.com', 'careers@acme.com', 'security@acme.com', 'media@acme.com', 'help@acme.com']) {
    assert.equal(publishedEmail({ contact: bad }), null, bad)
    assert.equal(publishedContact({ contact: bad })?.purpose, 'non-sales', bad)
  }
  assert.equal(publishedContact({ contact: 'press@figma.com' })?.purposeHint, 'press')
})

test('purpose: general business inboxes stay sales-contactable', () => {
  for (const good of ['info@acme.com', 'hello@acme.com', 'sales@acme.com', 'contact@acme.com', 'office@acme.com', 'team@acme.com', 'partnerships@acme.com']) {
    assert.equal(publishedEmail({ contact: good }), good, good)
  }
})

test('purpose applies to sitecrawl-published addresses exactly as to lead contacts', () => {
  const press = { contact: null, enrichments: [{ connector: 'sitecrawl', kind: 'email', value: 'press@figma.com' }] }
  assert.equal(publishedEmail(press), null)
  const info = { contact: null, enrichments: [{ connector: 'sitecrawl', kind: 'email', value: 'info@acme.com' }] }
  assert.equal(publishedEmail(info), 'info@acme.com')
})


test('malformed @ strings never offer an unsendable draft or hide a valid crawl address', () => {
  for (const contact of ['bad@', 'Name <sales@acme.com>', 'sales@acme', 'two words@acme.com']) {
    assert.equal(publishedEmail({contact}),null)
    assert.equal(publishedEmail({contact,enrichments:[{connector:'sitecrawl',kind:'email',value:' INFO@ACME.COM '}]}),'info@acme.com')
  }
  assert.equal(publishedEmail({contact:' SALES@ACME.COM '}),'sales@acme.com')
  assert.equal(publishedEmail({contact:null,enrichments:[{connector:'sitecrawl',kind:'email',value:'bad@'}]}),null)
})
