import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { adjacentLeadId } from '../app/app/leads/leads-side-panel-nav.ts'

// #1038, PR 2 of 3: clicking a table row opens a side panel with the lead's details and prev/next
// through the rows in the visible (tab-filtered, sorted) order. Rendered proof rides in
// test/ui/lead-cards.ui.mjs's table scenario (open / next / prev / close at both widths).
const PANEL = readFileSync(new URL('../app/app/leads/leads-side-panel.tsx', import.meta.url), 'utf8')
const TABLE = readFileSync(new URL('../app/app/leads/leads-table.tsx', import.meta.url), 'utf8')
const CLIENT = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')

test('#1038 the side panel renders the promised structure', () => {
  assert.match(PANEL, /data-testid="leads-side-panel"/, 'the panel is identifiable')
  assert.match(PANEL, /data-testid="side-panel-prev"/, 'prev control')
  assert.match(PANEL, /data-testid="side-panel-next"/, 'next control')
  assert.match(PANEL, /aria-label="Close"/, 'a close control')
  assert.match(PANEL, /leadCardSummary/, 'details reuse the card summary')
  assert.match(PANEL, /leadPerson/, 'person comes from the same buyer logic')
  assert.match(PANEL, /ContactStatusLine/, 'email status reuses the card status line')
  for (const label of ['Signal', 'Fit', 'Email', 'Approval']) assert.ok(PANEL.includes(label), `panel section: ${label}`)
  assert.match(PANEL, /disabled=\{!hasPrev\}/, 'prev disables at the first row')
  assert.match(PANEL, /disabled=\{!hasNext\}/, 'next disables at the last row')
})

test('#1038 the panel Approval section offers Review in Cards for leads that are not rejected (Quest on #1869)', () => {
  // The button is navigation, not an action: Approve/Reject stay on the cards, the table and panel get none.
  assert.match(PANEL, /data-testid="side-panel-review-in-cards"/, 'the button is identifiable')
  assert.match(PANEL, /Review in Cards/, 'the button says what it does')
  assert.match(PANEL, /!lead\.quarantined_at/, 'never shown for a rejected lead')
  assert.match(PANEL, /onReviewInCards\(lead\.id\)/, 'it hands the lead id to the client')
  assert.doesNotMatch(PANEL, /onApprove|onReject|approve-lead|reject-lead|quarantine\(/, 'no Approve/Reject actions in the panel')
})

test('#1038 Review in Cards switches to Cards, closes the panel, scrolls to and focuses the card (Quest on #1869)', () => {
  assert.match(CLIENT, /onReviewInCards=\{/, 'the panel gets the handler')
  assert.match(CLIENT, /reviewLeadInCards/, 'the client names the handler')
  assert.match(CLIENT, /chooseLeadsView\('cards'\)/, 'it switches to the Cards view')
  assert.match(CLIENT, /setPanelLeadId\(null\)/, 'it closes the panel')
  assert.match(CLIENT, /id=\{`lead-card-\$\{l\.id\}`\}/, 'each card is addressable by lead id')
  assert.match(CLIENT, /tabIndex=\{-1\}/, 'a card can take programmatic focus')
  assert.match(CLIENT, /scrollIntoView\(\{ block: 'center' \}\)/, 'the card scrolls into view')
  assert.match(CLIENT, /\.focus\(\{ preventScroll: true \}\)/, 'the card takes focus without a second scroll')
})

test('#1038 adjacentLeadId walks the visible order and clamps at the ends', () => {
  const ids = ['a', 'b', 'c']
  assert.equal(adjacentLeadId(ids, 'a', 1), 'b')
  assert.equal(adjacentLeadId(ids, 'b', -1), 'a')
  assert.equal(adjacentLeadId(ids, 'b', 1), 'c')
  assert.equal(adjacentLeadId(ids, 'a', -1), null, 'no prev before the first row')
  assert.equal(adjacentLeadId(ids, 'c', 1), null, 'no next past the last row')
  assert.equal(adjacentLeadId(ids, 'zzz', 1), null, 'an unknown id has no neighbour')
  assert.equal(adjacentLeadId([], 'a', 1), null, 'empty list')
})

test('#1038 rows open the panel and the client drives it in the visible order', () => {
  assert.match(TABLE, /onOpen/, 'the table takes an open callback')
  assert.match(TABLE, /onClick=\{\(\) => onOpen\(l\.id\)\}/, 'a row click opens its lead')
  assert.match(TABLE, /aria-selected=\{selectedId === l\.id\}/, 'the open row is marked')
  assert.match(CLIENT, /LeadsSidePanel/, 'the panel is wired in')
  assert.match(CLIENT, /panelLeadId/, 'the client holds the open lead')
  assert.match(CLIENT, /adjacentLeadId/, 'navigation walks the visible order')
  assert.match(CLIENT, /sortLeads\(/, 'the visible order is the sorted one (sort state lifted to the client)')
})

test('#1038 review fixes: panel names the buyer like the card, links the proof, rows are keyboard-openable, the hint stays clickable', () => {
  // Qodo on #1869: the panel called leadPerson without the site identity the card passes, so a current
  // person found on the company site showed as "No buyer named yet" in the panel while the card named them.
  assert.match(PANEL, /identityOf\(\{ id: lead\.id, contact: lead\.contact \}, lead\.enrichments \?\? \[\]\)/, 'the panel passes the same site identity as the card')
  // Qodo on #1869: the panel omitted the lead's proof source, which the card shows as "Proof: <host>".
  assert.match(PANEL, /Proof: \{c\.sourceHost\}/, 'the panel links the proof source like the card')
  assert.match(PANEL, /href=\{c\.sourceUrl\}/, 'the proof link opens the source URL')
  // Qodo on #1869: the row click was mouse-only; the table is one tab stop and arrow keys + Enter open a row.
  assert.match(TABLE, /tabIndex=\{0\}/, 'the table is a keyboard focus target')
  assert.match(TABLE, /onKeyDown/, 'the table handles keys')
  assert.match(TABLE, /ArrowDown/, 'arrow keys move the focused row')
  assert.match(TABLE, /Enter/, 'Enter opens the focused row')
  // Qodo on #1869: clicking the contact hint bubbled to the row and opened the panel over it.
  assert.match(TABLE, /stopPropagation/, 'the contact hint click never reaches the row')
})
