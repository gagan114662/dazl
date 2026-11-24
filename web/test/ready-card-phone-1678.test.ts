// #1678 (Quest walkthrough, production, 2026-11-24, 390px): on the first-run card, step 2 "Search can run" has two buttons
// (Add key, Link Google) that do not shrink, so its title and detail were squeezed to a sliver beside them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('#1678 at phone width a first-run step wraps: the text keeps the row beside the number, the buttons go underneath', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  const m = /@media \(max-width: 639px\) \{ \.rc-item \{ flex-wrap: wrap; \} \.rc-item > div \{ flex: 1 1 calc\(100% - 2\.75rem\); \} \}/.exec(css)
  assert.ok(m, 'the phone rule for .rc-item')
  // the buttons stay unshrinkable and the text block is the only <div> child of the item, so the rule above addresses it alone
  const card = readFileSync(new URL('../app/app/ready-card.tsx', import.meta.url), 'utf8')
  assert.match(card, /<li key=\{x\.id\} className="rc-item"/)
  assert.equal((card.match(/<div className="min-w-0 flex-1">/g) ?? []).length, 1)
})
