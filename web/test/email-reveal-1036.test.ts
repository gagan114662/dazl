// #1036 free email tier: addresses a company prints on its own site but hides from scrapers (Cloudflare Email Address Obfuscation,
// "[at]"/"[dot]" text) are read as a visitor sees them. Pure: invented company and people, no network, no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeCfEmail, revealEmails } from '../lib/people/email-reveal.ts'
import { personalAddresses } from '../lib/people/email-pattern.ts'
import { extractContacts } from '../lib/connectors/sitecrawl.ts'

// Cloudflare's own encoding: a one-byte key, then every byte of the address XOR key, as hex.
const cf = (address: string, key = 0x5a) => key.toString(16).padStart(2, '0') + [...new TextEncoder().encode(address)].map(b => (b ^ key).toString(16).padStart(2, '0')).join('')
const page = (b: string) => `<html><body>${b}</body></html>`

test('decodeCfEmail decodes Cloudflare hex and refuses anything that is not one address', () => {
  assert.equal(decodeCfEmail(cf('jane.doe@acme-roofing.com')), 'jane.doe@acme-roofing.com')
  assert.equal(decodeCfEmail(cf('Jane.Doe@Acme.com', 0x13)), 'jane.doe@acme.com')
  assert.equal(decodeCfEmail(cf('info@acme.com?subject=Quote')), 'info@acme.com')
  assert.equal(decodeCfEmail(cf('not an address')), null)
  assert.equal(decodeCfEmail('zz12'), null)
  assert.equal(decodeCfEmail(''), null)
})

test('revealEmails rewrites the Cloudflare span and href in place; a bad HEX is left untouched', () => {
  const hex = cf('jane.doe@acme.com')
  const html = page(`<p>Jane Doe, Owner</p><a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a>`)
  const out = revealEmails(html)
  assert.ok(out.includes('href="mailto:jane.doe@acme.com"'), out)
  assert.ok(out.includes('>jane.doe@acme.com</a>'), out)
  assert.ok(!out.includes('email&#160;protected'))
  const absolute = revealEmails(`<a href='https://acme.com/cdn-cgi/l/email-protection#${hex}'>mail</a>`)
  assert.equal(absolute, `<a href='mailto:jane.doe@acme.com'>mail</a>`)
  const bad = `<span class="__cf_email__" data-cfemail="5a5b5c">[email&#160;protected]</span>`
  assert.equal(revealEmails(bad), bad)
  const plain = page('<p>No addresses here, see us at acme.com</p>')
  assert.equal(revealEmails(plain), plain)
})

test('bracketed [at]/[dot] forms are read; a bare "at" sentence is not', () => {
  assert.equal(revealEmails('Write to jane.doe [at] acme [dot] com today'), 'Write to jane.doe@acme.com today')
  assert.equal(revealEmails('jane(at)acme.co.uk'), 'jane@acme.co.uk')
  assert.equal(revealEmails('j.smith {at} north-star (dot) ca'), 'j.smith@north-star.ca')
  assert.equal(revealEmails('Meet us at acme.com or at acme dot com'), 'Meet us at acme.com or at acme dot com')
})

test('the published personal tier now sees a Cloudflare-protected address on the company site', () => {
  const hex = cf('jane.doe@acme.com')
  const html = page(`<div class="team"><h3>Jane Doe</h3><p>Founder</p><a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a></div>`)
  assert.deepEqual(personalAddresses(html, 'acme.com'), [])                              // before: hidden
  const found = personalAddresses(revealEmails(html), 'acme.com')
  assert.deepEqual(found.map(f => f.address), ['jane.doe@acme.com'])                     // after: the printed address
  // another company's protected address is still refused by the same-site rule
  const other = page(`<span class="__cf_email__" data-cfemail="${cf('bob@other.org')}">[email&#160;protected]</span>`)
  assert.deepEqual(personalAddresses(revealEmails(other), 'acme.com'), [])
})

test('role inboxes hidden by Cloudflare or brackets are found by extractContacts; same-site rule unchanged', () => {
  const html = page(`<a href="/cdn-cgi/l/email-protection#${cf('info@acme.com')}"><span class="__cf_email__" data-cfemail="${cf('info@acme.com')}">[email&#160;protected]</span></a> sales [at] acme [dot] com <span data-cfemail="${cf('info@other.org')}">x</span>`)
  const emails = extractContacts(html, 'https://acme.com/contact', 'acme.com').filter(f => f.kind === 'email').map(f => f.value).sort()
  assert.deepEqual(emails, ['info@acme.com', 'sales@acme.com'])
})
