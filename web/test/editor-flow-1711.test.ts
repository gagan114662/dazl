// #1711 (items 1 route half, 3, 5 + skipped toggle): the draft editor and approve flow failed silently. These
// checks pin the user-visible behaviour at the layer each fix lives in, in the source-assertion style of the
// existing UI tests. Per the file-ownership map on #1579, items 6 and 7 and item 1's leads-page rendering live
// in Codex's leads-client.tsx / checked-client.tsx and land as Codex's follow-up; items 2 (placeholder
// rejection) and 4 (unapprove) live in Codex's service.ts, held until #1734 merges. None are covered here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\\'/g, "'")
const route = read('../app/api/outreach/route.ts')
const outreachClient = read('../app/app/outreach/outreach-client.tsx')
const outcomesClient = read('../app/app/outcomes/outcomes-client.tsx')

test('#1711 item 1: the seller-context error points at Business, not the Home page, and carries a fix link', () => {
  assert.match(route, /seller_context_required: \[422, '[^']*Business[^']*'\]/, 'the error copy names Business')
  assert.doesNotMatch(route, /Add your business name on the Home page/, 'the old, wrong directions are gone')
  assert.match(route, /fix_href: '\/app\/business'/, 'the response carries the page that holds the field')
})

test('#1711 item 3: a failed save says what is wrong, next to the editor, and the edit stays open', () => {
  assert.match(outreachClient, /bad_subject/, 'the save error names the subject problem')
  assert.match(outreachClient, /bad_body/, 'the save error names the body problem')
  assert.match(outreachClient, /editError/, 'the error is held per message, beside the editor')
  assert.doesNotMatch(outreachClient, /Subject or message is the wrong length/, 'the old generic note is gone')
})

test('#1711 skipped drafts: hidden by default behind a Show skipped toggle', () => {
  assert.match(outreachClient, /Show skipped/, 'the toggle is offered')
  assert.match(outreachClient, /showSkipped/, 'the toggle is state')
  assert.match(outreachClient, /status !== 'skipped'/, 'skipped messages are filtered out by default')
  assert.match(outreachClient, /const skippedCount = base\.filter/, 'the count comes from the scan-filtered list this view can reveal (Qodo)')
})

test('#1711 item 5: outcomes says when drafts wait on other searches instead of none waiting', () => {
  assert.match(outcomesClient, /\/api\/outreach/, 'the account-wide drafts are read')
  assert.match(outcomesClient, /waiting across all your searches/, 'the empty state names the other searches')
  assert.match(outcomesClient, /No drafts waiting for this search/, 'and says this search has none')
})

test('#1711 item 5 follow-up (Qodo): the waiting count is an aggregate, not a filter of the 200-capped list', async () => {
  assert.match(route, /waiting_count/, 'the outreach GET response carries the count')
  assert.match(route, /SELECT COUNT\(\*\) AS n FROM outreach_messages WHERE tenant_id = \? AND status IN \('draft', 'approved'\)/, 'counted with its own aggregate query')
  assert.match(outcomesClient, /waiting_count/, 'outcomes reads the aggregate')
  // Behavioural: seed one old waiting draft behind 205 newer sent messages. The list caps at 200, so a
  // count filtered from it would say 0; the shipped aggregate SQL must still say 1.
  const { default: Database } = await import('better-sqlite3')
  const { migrateScan } = await import('../lib/scan/store.ts')
  const { migrateOutreach } = await import('../lib/outreach/store.ts')
  const { seedOffers } = await import('./helpers/seed-offer.ts')
  const { migrateConnectors } = await import('../lib/connectors/store.ts')
  const { listMessages } = await import('../lib/outreach/service.ts')
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db)
  const ins = db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at) VALUES (?, 'A', ?, ?, 'S', 'Body text for the seeded message row.', ?, ?)")
  ins.run('old-draft', 'L-old', 'old@x.example', 'draft', 1000)
  for (let i = 0; i < 205; i++) ins.run(`sent-${i}`, `L-${i}`, `s${i}@x.example`, 'sent', 2000 + i)
  const sql = /SELECT COUNT\(\*\) AS n FROM outreach_messages[^"]*/.exec(route)?.[0]
  assert.ok(sql, 'the aggregate SQL is extractable from the route')
  assert.equal((db.prepare(sql).get('A') as { n: number }).n, 1, 'the aggregate still counts the older waiting draft')
  assert.equal(listMessages(db, 'A').filter(m => m.status === 'draft' || m.status === 'approved').length, 0, 'and the capped list really would have missed it')
  db.close()
})

