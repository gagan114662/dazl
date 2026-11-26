// Guard on the reader that already dates a company's own posting from schema.org (lib/scan/structured-date.ts): the day comes
// from `datePosted`, the node must name the company being cited, and a page without `datePosted` gives nothing at all.
// The markup below is recorded in this repo's fixtures, not written for the test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveStructuredDate } from '../lib/scan/structured-date.ts'

const blocksOf = (fixture: string): string[] =>
  [...readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])

const n8n = blocksOf('ashby-site/n8n.html')
const mintlify = blocksOf('ashby-site/mintlify.html')

test('CAREERS a recorded JobPosting dates itself from datePosted and its hiringOrganization', () => {
  assert.deepEqual(resolveStructuredDate(n8n, 'n8n', 'is hiring a Sales Development Representative for South EMEA'), { date: '2026-11-02', kind: 'JobPosting' })
  assert.deepEqual(resolveStructuredDate(mintlify, 'Mintlify', 'is hiring a Sales Development Representative'), { date: '2026-10-21', kind: 'JobPosting' })
})

test('CAREERS the same page gives nothing for another company or another role', () => {
  assert.equal(resolveStructuredDate(n8n, 'Acme Widgets', 'is hiring a Sales Development Representative'), null, "another company's posting is not this company's date")
  assert.equal(resolveStructuredDate(n8n, 'n8n', 'is hiring a payroll administrator'), null, 'a different role on the page is not this claim')
})

test('CAREERS edit stamps are never a posting date', () => {
  const editOnly = [`{"@context":"https://schema.org/","@type":"JobPosting","title":"Sales Development Representative","dateModified":"2026-11-25","datePublished":"2026-11-24","hiringOrganization":{"@type":"Organization","name":"n8n"}}`]
  assert.equal(resolveStructuredDate(editOnly, 'n8n', 'is hiring a Sales Development Representative'), null, 'dateModified/datePublished cannot date the posting')
})

test('CAREERS control: a hiring claim on a page with no JobPosting gets no date', () => {
  assert.equal(resolveStructuredDate(blocksOf('ashby-site/n8n.html').map(b => b.replace(/"JobPosting"/g, '"Article"').replace(/"datePosted":"[^"]*"/g, '"x":"y"')), 'n8n', 'is hiring a Sales Development Representative'), null)
  assert.equal(resolveStructuredDate([], 'n8n', 'is hiring a Sales Development Representative'), null, 'no markup at all gives nothing')
})
