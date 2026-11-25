// #1722 (Outreach item): the Outreach page overflowed sideways at 390px because a draft body with a long
// unbroken URL renders in a whitespace-pre-wrap <pre>, which does not break long words. These checks pin
// break-words on every long-text render in the draft card (body, footer, subject).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/app/outreach/outreach-client.tsx', import.meta.url), 'utf8')

test('#1722 long draft text wraps at phone width instead of overflowing', () => {
  assert.match(src, /<pre className="whitespace-pre-wrap break-words text-\[#333\] font-sans mb-3">\{m\.body\}<\/pre>/, 'the draft body breaks long words')
  assert.match(src, /<pre className="whitespace-pre-wrap break-words text-\[#666\] font-sans text-xs"/, 'the send footer (which can carry a long booking URL) breaks long words')
  assert.match(src, /<div className="font-medium break-words mb-1">\{m\.subject\}<\/div>/, 'the subject line breaks long words')
})
