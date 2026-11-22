// Qodo High on #1532 (Refs #1122): a call-to-action next to a CEO line ("Contact Us" beside "Chief Executive Officer") is never a person,
// in any markup (button, link, nav text, plain text). Real names beside a CEO line, short surnames included, still pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople } from '../lib/connectors/sitecrawl.ts'

const WHO = 'Founder, CEO, Head of Sales'
// prose that never writes "us", "in", "more", "started" in lower case: the lower-case word test must not be what saves us
const prose = '<p>' + 'Teams build software here and customers care about quality every single day of the year, from small shops to large firms that want reliable tools and honest support '.repeat(3) + '</p>'
const names = (block: string, path = '/about-us') => extractPeople(`<html><body>${prose}${block}</body></html>`, `https://acme.com${path}`, WHO).map(f => f.value.split(',')[0])
const CTAS = ['Contact Us', 'About Us', 'Join Us', 'Sign In', 'Book a Demo', 'Get Started', 'Learn More', 'Talk To Us', 'Log In', 'Read More']
const shapes: [string, (c: string) => string][] = [
  ['button', c => `<div><button class="btn">${c}</button><p>Chief Executive Officer</p></div>`],
  ['link', c => `<div><a href="/x">${c}</a><p>Chief Executive Officer</p></div>`],
  ['nav', c => `<nav><span>${c}</span></nav><p>Chief Executive Officer</p>`],
  ['plain', c => `<div><p>${c}</p><p>Chief Executive Officer</p></div>`],
  ['same line', c => `<p>${c} - CEO</p>`],
  ['heading', c => `<h3>${c}</h3><p>CEO</p>`],
]

for (const [shape, html] of shapes) {
  test(`#1532 High: no call-to-action is a person beside a CEO line (${shape})`, () => {
    for (const c of CTAS) assert.deepEqual(names(html(c)), [], `${c} as ${shape}`)
  })
}

test('#1532 High: the exact page shape (Simple AI): a "Contact Us" button between the CEO and her title never displaces her', () => {
  const got = names('<ul><li><p>Catheryn Li</p><p>Chief Executive Officer</p></li></ul><div><button>Contact Us</button></div><p>Chief Executive Officer</p>')
  assert.deepEqual(got, ['Catheryn Li'])
})

test('#1532 High: real names beside a CEO line still pass, short surnames included', () => {
  for (const n of ['Catheryn Li', 'Daniel Ng', 'Mei Wu', 'Ray Ho', 'Anna Carter', 'Dr. Priya Raman']) {
    assert.deepEqual(names(`<ul><li><p>${n}</p><p>Chief Executive Officer</p></li></ul>`), [n], n)
    assert.deepEqual(names(`<p>${n}, CEO</p>`), [n], `${n} same line`)
  }
})

test('Qodo #1542: a capital middle initial and the given name An are name tokens; a stacked listing keeps every pair', () => {
  assert.deepEqual(names('<ul><li><p>Maya A. Thornton</p><p>Chief Executive Officer</p></li><li><p>Ana Lee</p><p>Founder</p></li></ul>'), ['Maya A. Thornton', 'Ana Lee'])
  assert.deepEqual(names('<ul><li><p>An Nguyen</p><p>CEO</p></li></ul>'), ['An Nguyen'])
})
