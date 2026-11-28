import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sc from '../lib/connectors/sitecrawl.ts'

// #2145: the homepage identity check refused a firm's own correct site because the lead name carried a professional-form suffix
// (LLP, Professional Corporation) that the homepage drops. Fictional firms; the page is a sample shaped like a small firm's homepage.
const page = (name: string, extra = '') => `<html><body><h1>${name}</h1><p>Chartered professional accountants. 400, 123 8 Ave SW, Calgary, AB T2P 1B3</p>${extra}<a href="/contact">Contact</a></body></html>`
const reasonFor = async (company: string, homeName: string) => {
  const home = page(homeName)
  const get: sc.Get = async url => {
    const u = new URL(url)
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: home, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  return (await sc.crawlSite('example-firm.ca', get, 0, company)).reason
}

test('#2145 a lead name with a professional-form suffix matches the homepage that drops it', async () => {
  assert.notEqual(await reasonFor('Birchwood Tax LLP', 'Birchwood Tax'), 'name_mismatch')
  assert.notEqual(await reasonFor('Birchwood Tax Professional Corporation', 'Birchwood Tax'), 'name_mismatch')
  assert.notEqual(await reasonFor('Birchwood Tax, CPA', 'Birchwood Tax'), 'name_mismatch')
  assert.notEqual(await reasonFor('Lindqvist Professional Corporation', 'Lindqvist'), 'name_mismatch')
})

test('#2145 control: a homepage naming a different firm is still refused', async () => {
  assert.equal(await reasonFor('Birchwood Tax LLP', 'Northline Marketing'), 'name_mismatch')
  assert.equal(await reasonFor('Birchwood Tax LLP', 'Birchwood Dental'), 'name_mismatch')
})

test('#2145 control: a short stem keeps the whole name, so "Ace LLP" is not matched by any page that says "Ace"', async () => {
  assert.equal(await reasonFor('Ace LLP', 'Ace Hardware'), 'name_mismatch')
  assert.equal(sc.identityNorm('Ace LLP'), 'acellp')
})

test('#2145 control: names without a trailing form behave as before, and a form word inside the name is kept', () => {
  assert.equal(sc.identityNorm('Birchwood Tax'), 'birchwoodtax')
  assert.equal(sc.identityNorm('PC Solutions Group'), 'pcsolutions')
  assert.equal(sc.identityNorm('Birchwood Tax LLP'), 'birchwoodtax')
  assert.equal(sc.identityNorm('Birchwood Tax LLC'), 'birchwoodtax')
})
