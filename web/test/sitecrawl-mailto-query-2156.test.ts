import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractContacts } from '../lib/connectors/sitecrawl.ts'

// #2156 follow-up: a role address published only inside a mailto href that carries a query
// string (mailto:partners@…?subject=…) is never read — Crawlee's URL pass validates the whole
// target, query included, as an address and drops it before the filters run. The fixture
// follows the real bread & Butter PR contact page: every mailto on it carries a ?subject=,
// and the anchor text is a button label, never the address itself.

const emails = (html: string, url: string, site: string) => extractContacts(html, url, site).filter(f => f.kind === 'email').map(f => f.value)

const URL = 'https://welovebreadandbutter.com/contact-us'
const SITE = 'welovebreadandbutter.com'
const page = (href: string) => `<html><body><h1>Contact Us</h1><p>Tell us where your brand is headed and what is standing in the way, and we will put together a public relations programme that fits the quarter you are planning for.</p><a href="${href}" class="contact_item right-align w-inline-block"><span>Start a partnership</span></a></body></html>`

test('a role address published only in a queried mailto href is found', () => {
  assert.deepEqual(emails(page('mailto:partners@welovebreadandbutter.com?subject=Partner%20Inquiry%20%5BSource%3A%20Website%5D'), URL, SITE), ['partners@welovebreadandbutter.com'])
})

test('control: the same role address in a plain mailto is found, unchanged', () => {
  assert.deepEqual(emails(page('mailto:partners@welovebreadandbutter.com'), URL, SITE), ['partners@welovebreadandbutter.com'])
})

test('control: a queried mailto with a non-role address is classified exactly as its plain form', () => {
  // wellhello@ is the other mailbox the real page publishes; it is not a role word, so the
  // plain form yields nothing here and the queried form must yield nothing either — the
  // query strip must not turn a personal mailbox into a role row.
  assert.deepEqual(emails(page('mailto:wellhello@welovebreadandbutter.com'), URL, SITE), [])
  assert.deepEqual(emails(page('mailto:wellhello@welovebreadandbutter.com?subject=Email%20Inquiry%20%5BSource%3A%20Website%5D'), URL, SITE), [])
})

test('control: a queried mailto on a different domain is still ignored', () => {
  assert.deepEqual(emails(page('mailto:partners@otheragency.com?subject=Partner%20Inquiry'), URL, SITE), [])
})
