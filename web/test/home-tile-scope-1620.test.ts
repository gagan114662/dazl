// #1620: Home's 30-day tiles say they cover every search, so their numbers are not read as one search's count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homeWindowHeading, homeWindowScope } from '../lib/outreach/hold-words.ts'

test('#1620 the heading and the scope line name every search and the window', () => {
  assert.equal(homeWindowHeading(30), 'Last 30 days, all your searches')
  assert.equal(homeWindowScope(30), 'These numbers add up every search you ran in the last 30 days, one count per company. A single search shows its own, smaller numbers on its page.')
})
test('#1620 Home renders both from the one place', () => {
  const src = readFileSync(new URL('../app/app/home-results.tsx', import.meta.url), 'utf8')
  assert.match(src, /<h2 id="h-results"[^>]*>\{homeWindowHeading\(r\.window_days\)\}<\/h2>/)
  assert.match(src, /data-testid="results-scope">\{homeWindowScope\(r\.window_days\)\}/)
})
