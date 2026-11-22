import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redirectStaysOnSite } from '../lib/connectors/sitecrawl.ts'

// Run af02437c: uare.ai|site_unreachable. The real chain (2026-11-22): https://uare.ai/ 307 -> https://www.uare.ai/ 307 -> https://app.uare.ai/site.
// The fetch only followed apex<->www, so the company's own subdomain hop failed the homepage read.
test('af02437c: a redirect to a subdomain of the same site is followed (uare.ai -> www.uare.ai -> app.uare.ai)', () => {
  assert.equal(redirectStaysOnSite('https://uare.ai/', 'https://www.uare.ai/'), true)
  assert.equal(redirectStaysOnSite('https://www.uare.ai/', 'https://app.uare.ai/site'), true)
})
test('a redirect off the site is still refused (another domain, a look-alike suffix, or up to a parent)', () => {
  assert.equal(redirectStaysOnSite('https://www.uare.ai/', 'https://uare.ai.evil.com/'), false)
  assert.equal(redirectStaysOnSite('https://www.uare.ai/', 'https://notuare.ai/'), false)
  assert.equal(redirectStaysOnSite('https://acme.example/', 'https://linktr.ee/acme'), false)
  assert.equal(redirectStaysOnSite('https://app.acme.com/', 'https://acme.com/'), false)
  assert.equal(redirectStaysOnSite('https://acme.com/', 'http://app.acme.com/'), false)
})
