import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1814: /pricing has no page of its own; it sends the visitor to the homepage's pricing block. A redirect to a
// fragment the homepage does not render lands on the top of the page instead, so both halves are held here: the
// redirect's target, and the one element on the homepage that carries that id around the pricing copy.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const redirectTarget = () => {
  const m = /redirect\(\s*'([^']+)'\s*\)/.exec(read('../app/pricing/page.tsx'))
  assert.ok(m, '/pricing redirects instead of rendering its own page')
  return m![1]
}

test('#1814 /pricing sends the visitor to the homepage pricing block', () => {
  assert.equal(redirectTarget(), '/#pricing')
})

test('#1814 the homepage renders exactly one element with the id the redirect points at', () => {
  const fragment = /^\/#([A-Za-z0-9_-]+)$/.exec(redirectTarget())
  assert.ok(fragment, 'the redirect target is a fragment on the homepage')
  const id = fragment![1]

  const page = read('../app/page.tsx')
  const anchors = [...page.matchAll(new RegExp(`id="${id}"`, 'g'))]
  assert.equal(anchors.length, 1, `the homepage renders exactly one id="${id}"`)
})

test('#1814 that anchor sits on a <section> that holds the pricing copy', () => {
  const id = /^\/#([A-Za-z0-9_-]+)$/.exec(redirectTarget())![1]
  const page = read('../app/page.tsx')
  const at = page.indexOf(`id="${id}"`)
  const block = page.slice(page.lastIndexOf('<section', at), page.indexOf('</section>', at))

  assert.match(block, new RegExp(`<section id="${id}"`), `the anchor is the section's own id, not a child's`)
  assert.match(block, /Free during the beta/, 'the section holds the pricing heading')
  assert.match(block, /data-testid="free-beta-card"/, 'the section holds the pricing card')
})
