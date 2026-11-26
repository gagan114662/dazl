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

// Recorded from the pages prod leads actually point at (fetched 2026-11-26). One carries a JobPosting; the rest carry none, which
// is the honest control: a company-owned careers page that names no date must yield nothing rather than a nearby or edited stamp.
const recorded = (name: string): { url: string; blocks: string[] } =>
  JSON.parse(readFileSync(new URL(`./fixtures/careers-2020/${name}`, import.meta.url), 'utf8'))

test('CAREERS a company-owned page that declares datePosted is dated by it', () => {
  const { url, blocks } = recorded('yonovo-software-us.json')
  assert.equal(url, 'https://www.yonovo.com/careers/founding-sdr')
  assert.deepEqual(resolveStructuredDate(blocks, 'Yonovo', 'is hiring a Founding Sales Development Representative'), { date: '2026-10-20', kind: 'JobPosting' })
})

// Ziggy named these three employers directly (no prod lead points at them), so the fixtures say so. All three run their own
// career site and publish no JSON-LD at all: the reader must return null rather than infer a day from anything else.
test('CAREERS EU employers named by Ziggy publish no datePosted, so they get no date', () => {
  for (const [name, country, industry, company, claim] of [
    ['zalando-named-by-ziggy.json', 'Germany', 'e-commerce', 'Zalando', 'is hiring a Senior SAP Consultant'],
    ['bolt-named-by-ziggy.json', 'Estonia', 'transport', 'Bolt', 'is hiring an operations specialist'],
    ['spotify-named-by-ziggy.json', 'Sweden', 'media', 'Spotify', 'is hiring a Social Marketing Manager'],
  ] as const) {
    const f = recorded(name) as { named_by: string; country: string; industry: string; url: string; blocks: string[] }
    assert.equal(f.named_by, 'Ziggy', `${name} is labelled as named, not as a prod lead`)
    assert.equal(f.country, country)
    assert.equal(f.industry, industry)
    assert.equal(f.blocks.length, 0, `${f.url} carries no JSON-LD`)
    assert.equal(resolveStructuredDate(f.blocks, company, claim), null)
  }
})

test('CAREERS recorded company-owned pages with no JobPosting give no date', () => {
  for (const [name, company, claim] of [
    ['mediaforce-marketing-ca.json', 'Mediaforce', 'is hiring a Business Development Representative'],
    ['abacus-plumbing-us.json', 'Abacus Plumbing', 'is hiring a plumber'],
    ['cleanor-service-us.json', 'Cleanor', 'is hiring cleaners'],
    ['plumbers-that-care-us.json', 'Plumbers That Care', 'is hiring a plumber'],
    ['lime-advertising-us.json', 'Lime Advertising', 'is hiring a Business Development Representative'],
  ] as const) {
    const { blocks } = recorded(name)
    assert.equal(resolveStructuredDate(blocks, company, claim), null, `${name} declares no datePosted`)
  }
  assert.equal(recorded('cleanor-service-us.json').blocks.length, 0, 'that page carries no JSON-LD at all, recorded as such')
})

test('CAREERS control: a hiring claim on a page with no JobPosting gets no date', () => {
  assert.equal(resolveStructuredDate(blocksOf('ashby-site/n8n.html').map(b => b.replace(/"JobPosting"/g, '"Article"').replace(/"datePosted":"[^"]*"/g, '"x":"y"')), 'n8n', 'is hiring a Sales Development Representative'), null)
  assert.equal(resolveStructuredDate([], 'n8n', 'is hiring a Sales Development Representative'), null, 'no markup at all gives nothing')
})
