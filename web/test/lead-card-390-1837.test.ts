import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1837: at 390px the lead card's action row (Approve / Message on LinkedIn / Reject) was cut off on the right
// and the summary text was clipped on the left, with no sideways page scroll. Source mechanism: the row's
// `flex gap-2 shrink-0 pl-[52px]` is ~398px of unwrappable min-content, wider than a 390px viewport; it forced
// the centered column (max-w-6xl mx-auto) wider than the screen, clipping BOTH edges. The row must wrap and the
// text must wrap. Class-level pin; the rendered check at 390px is the issue's live check.
const tsx = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
const actions = /<div className="([^"]*)" data-testid="card-actions">/.exec(tsx)?.[1].split(/\s+/) ?? []
const why = /<p className="([^"]*)">\{c\.why\}<\/p>/.exec(tsx)?.[1].split(/\s+/) ?? []

test('#1837 the card action row wraps instead of forcing the card wider than a 390px viewport', () => {
  assert.ok(actions.length > 0, 'card-actions row found')
  assert.ok(actions.includes('flex-wrap'), 'the row wraps its buttons onto a second line')
  assert.ok(!actions.includes('shrink-0'), 'shrink-0 let the row keep a width the viewport cannot fit')
  assert.ok(actions.includes('min-w-0'), 'the row may shrink inside the centered column')
  // Ziggy re-review on #1845: at sm+ the actions sit beside the identity block; without sm:shrink-0
  // the actions row squeezes it. The exact-token check above still passes: sm:shrink-0 is not shrink-0.
  assert.ok(actions.includes('sm:shrink-0'), 'at sm+ the actions row holds its width instead of squeezing the identity')
})

test('#1837 the card summary text wraps, so it cannot be clipped at the card edge', () => {
  assert.ok(why.length > 0, 'summary <p> found')
  assert.ok(why.includes('break-words'), 'long tokens wrap instead of overflowing')
})
