// #1603 (Muse lane, wording only): on every path into Gmail connect, before Google's own screen, the user is told
// plainly that dazl is waiting on Google's review, that Google's "hasn't verified this app" warning is expected,
// and what to click (Advanced, then Go to dazl). These source checks pin that note on the three allowed surfaces:
// the connect-gmail explainer page, the Settings Gmail panel, and the inline gmail-gate notice. The note must name
// dazl (never Foolish), must not promise a review outcome or a date, and on the explainer page it must sit with the
// warning block so it disappears once Google has verified the app.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

// Copy in these components is written as JSX string expressions to satisfy react/no-unescaped-entities, so an
// apostrophe appears in source as \'. Normalise that back before matching: the checks below are about the words
// the user reads, not the source escaping.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\\'/g, "'")

const PAGE = '../app/app/connect-gmail/page.tsx'
const PANEL = '../app/app/settings/gmail-panel.tsx'
const GATE = '../app/app/gmail-gate.tsx'

test('#1603 the connect-gmail page shows the awaiting-verification note with the warning, naming dazl', () => {
  const src = read(PAGE)
  assert.match(src, /data-testid="gmail-verification-note"/, 'the page renders a dedicated verification note')
  assert.match(src, /waiting on Google's review/, 'the note says dazl is waiting on Google review')
  assert.match(src, /expected/, 'the note says the warning is expected')
  // The note belongs to the unverified-warning block: rendered only while x.warning is shown, so it goes away
  // on its own once the app is verified and the warning steps go.
  const noteAt = src.indexOf('gmail-verification-note')
  const warningAt = src.indexOf('x.warning')
  assert.ok(warningAt >= 0 && noteAt > warningAt, 'the note is inside the warning branch, after the warning check')
  assert.doesNotMatch(src, /Foolish/i, 'our own copy names dazl, not Foolish')
})

test('#1603 the Settings Gmail panel warns about the Google screen before the Connect click', () => {
  const src = read(PANEL)
  assert.match(src, /data-testid="gmail-panel-verification-note"/, 'the panel renders the verification note')
  assert.match(src, /waiting on Google's review/, 'the panel note says dazl is waiting on Google review')
  assert.match(src, /Google hasn't verified this app/, 'the panel names the warning in Google words')
  assert.match(src, /Advanced/, 'the panel says what to click: Advanced')
  assert.match(src, /Go to dazl/, 'the panel says what to click: Go to dazl')
  assert.doesNotMatch(src, /Foolish/i, 'our own copy names dazl, not Foolish')
})

test('#1603 the gmail-gate notice carries the same warning and routes through the explainer page', () => {
  const src = read(GATE)
  assert.match(src, /data-testid="gmail-gate-verification-note"/, 'the gate renders the verification note')
  assert.match(src, /waiting on Google's review/, 'the gate note says dazl is waiting on Google review')
  assert.match(src, /GMAIL_EXPLAINER_PATH/, 'the gate sends connect/reconnect through the explainer page')
  assert.doesNotMatch(src, /Foolish/i, 'our own copy names dazl, not Foolish')
})

test('#1603 the note promises no outcome and no date on any surface', () => {
  for (const rel of [PAGE, PANEL, GATE]) {
    const src = read(rel)
    assert.doesNotMatch(src, /will be verified|verified by (the end|next|Friday)|review will (finish|complete|pass)/i, `${rel}: no promised outcome or date`)
    assert.doesNotMatch(src, /[—–]/, `${rel}: plain punctuation`)
  }
})

test('#1603 (Qodo) the panel and gate notes retire when Google verifies the app, like the connect page', () => {
  const route = read('../app/api/outreach/settings/route.ts')
  const panel = read(PANEL)
  const gate = read(GATE)
  assert.match(route, /google_app_verified: googleAppVerified\(\)/, 'the settings read carries the server-side verification state to client surfaces')
  assert.match(panel, /!s\.google_app_verified/, 'the reconnect note is hidden once the app is verified')
  assert.match(panel, /!s\?\.google_app_verified/, 'the connect note is hidden once the app is verified')
  assert.match(gate, /!verified && <p className="mt-2" data-testid="gmail-gate-verification-note"/, 'the gate note is hidden once the app is verified')
  assert.match(gate, /google_app_verified === true/, 'the gate reads the state from the settings read')
})
