import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

for (const route of ['privacy', 'terms']) {
  test(`#1781 /${route} renders the shared site footer`, () => {
    const source = readFileSync(new URL(`../app/${route}/page.tsx`, import.meta.url), 'utf8')
    assert.match(source, /import SiteFooter from '\.\.\/site-footer'/)
    assert.match(source, /<SiteFooter(?: compact)? \/>/)
  })
}
