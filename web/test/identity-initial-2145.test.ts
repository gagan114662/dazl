import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sc from '../lib/connectors/sitecrawl.ts'

// #2145: a sole practitioner's lead name is "L Bloxham Professional Corporation"; the firm's own homepage says "Lesley Bloxham Professional Corporation".
const page = (title: string) => `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>Chartered professional accountants. 400, 123 8 Ave SW, Calgary, AB T2P 1B3</p><a href="/contact">Contact</a></body></html>`
const reasonFor = async (company: string, title: string) => {
  const home = page(title)
  const get: sc.Get = async url => {
    const u = new URL(url)
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: home, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  return (await sc.crawlSite('example-firm.ca', get, 0, company)).reason
}

test('#2145 an initial plus surname matches the full given name plus the same surname', async () => {
  assert.notEqual(await reasonFor('L Bloxham Professional Corporation', 'Calgary Accountant | Lesley Bloxham Professional Corporation'), 'name_mismatch')
  assert.notEqual(await reasonFor('L. Bloxham', 'Lesley Bloxham, CPA'), 'name_mismatch')
})

test('#2145 control: a different given name is refused', async () => {
  assert.equal(await reasonFor('L Bloxham Professional Corporation', 'Mark Bloxham Professional Corporation'), 'name_mismatch')
})

test('#2145 control: a surname that only starts the page\'s word is refused', async () => {
  assert.equal(await reasonFor('L Smith', 'Lesley Smithers Accounting'), 'name_mismatch')
})

test('#2145 control: an unrelated firm whose page only mentions the person in the body is refused', async () => {
  const unrelated = `<html><head><title>Northline Marketing</title></head><body><h1>Northline Marketing</h1><p>Our advisors: Lesley Bloxham, partner, and Mark Smith.</p><p>400, 123 8 Ave SW, Calgary, AB</p></body></html>`
  const get: sc.Get = async url => {
    const u = new URL(url)
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
    return u.pathname === '/' ? { status: 200, body: unrelated, finalUrl: url } : { status: 404, body: '', finalUrl: url }
  }
  assert.equal((await sc.crawlSite('example-firm.ca', get, 0, 'L Bloxham Professional Corporation')).reason, 'name_mismatch')
})

test('#2145 the first read and the cached replay agree, however far down the page the name sits', async () => {
  const pad = '<p>' + 'lorem ipsum '.repeat(4000) + '</p>'
  const deep = `<html><head><title>Lesley Bloxham Professional Corporation</title></head><body><h1>Home</h1>${pad}<p>Calgary, AB</p></body></html>`
  const bodyOnly = `<html><head><title>Welcome</title></head><body><h1>Home</h1>${pad}<p>Lesley Bloxham, partner. Calgary, AB</p></body></html>`
  for (const [html, want] of [[deep, true], [bodyOnly, false]] as const) {
    const get: sc.Get = async url => {
      const u = new URL(url)
      if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
      return u.pathname === '/' ? { status: 200, body: html, finalUrl: url } : { status: 404, body: '', finalUrl: url }
    }
    const first = await sc.crawlSite('example-firm.ca', get, 0, 'L Bloxham')
    assert.equal(first.reason !== 'name_mismatch', want)
    assert.equal(sc.nameOnPage('L Bloxham', first.homeNorm ?? '', first.homeHeading), want, 'the replay check on the stored result gives the same answer')
  }
})

test('#2145 control: a short surname and names that are not initial plus surname get no initial match', async () => {
  assert.equal(sc.nameOnPage('L Poe', 'lesleypoe', 'Lesley Poe'), false)
  assert.equal(sc.nameOnPage('L Bloxham', 'x', 'Lesley Bloxham'), true)
  assert.equal(sc.nameOnPage('Lesley Bloxham', 'lbloxham', 'L Bloxham'), false)
  assert.equal(sc.nameOnPage('Birchwood Tax LLP', 'northlinemarketing', 'Northline Marketing'), false)
  assert.equal(sc.nameOnPage('L Bloxham', 'lbloxham', ''), true)
  assert.equal(sc.nameOnPage('L Bloxham', 'x', ''), false)
})

test('#2145 control: a hyphen or apostrophe continues the surname, so L Smith is not Lesley Smith-Jones or Lesley Smith\u2019s; an exact compound surname still matches', async () => {
  assert.equal(await reasonFor('L Smith', 'Lesley Smith-Jones Accounting'), 'name_mismatch')
  assert.equal(await reasonFor('L Smith', 'Lesley Smith\u2019s Accounting'), 'name_mismatch')
  assert.equal(await reasonFor('L Smith', "Lesley Smith's Accounting"), 'name_mismatch')
  assert.notEqual(await reasonFor('L Smith-Jones', 'Lesley Smith-Jones Accounting'), 'name_mismatch')
  assert.notEqual(await reasonFor('L Smith', 'Lesley Smith, CPA'), 'name_mismatch')
})

test('#2145 an exact apostrophized surname matches (straight and curly); a prefix of it, or a different surname, does not', async () => {
  assert.notEqual(await reasonFor("L O'Connor", "Lesley O'Connor Accounting"), 'name_mismatch')
  assert.notEqual(await reasonFor('L O\u2019Connor', 'Lesley O\u2019Connor Accounting'), 'name_mismatch')
  assert.notEqual(await reasonFor("L O'Connor", 'Lesley O\u2019Connor, CPA'), 'name_mismatch')
  assert.equal(await reasonFor("L O'Connor", "Lesley O'Connor-Smith Accounting"), 'name_mismatch')
  assert.equal(await reasonFor("L O'Connor", "Lesley O'Brien Accounting"), 'name_mismatch')
  assert.equal(await reasonFor('L Smith', "Lesley Smith'n Co"), 'name_mismatch')
})
