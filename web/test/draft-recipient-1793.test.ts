import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import { createDraft, draftBlockReason, manualDraftBlockReason, OutreachError } from '../lib/outreach/service.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { createJob, migrateScan } from '../lib/scan/store.ts'

test('Refs #1793: automated inboxes yield a reason and no outreach draft', async t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateScan(db)
  migrateOutreach(db)
  migrateConnectors(db)
  migrateMemory(db)
  saveMemory(db, 'T', { positioning: 'Fit-out services' })
  const job = createJob(db, 'T', { business_name: 'Seller', industry: 'retail', location: 'Canada' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const addLead = db.prepare(`
    INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence,
      human_confirmed_at, human_confirmed_from)
    VALUES (?, ?, 'Example Shop', ?, 'Opening a second shop', 'https://shop.example/news',
      'Example Shop is opening a second shop', 90, 1800000000, 'test_review')
  `)
  const blocked = [
    'noreply', 'No-Reply+notice', 'donotreply', 'mailer-daemon',
    'postmaster', 'bounce', 'unsubscribe', 'notifications',
  ]
  for (const local of blocked) {
    addLead.run(local, job, `${local}@shop.example`)
    await t.test(local, () => {
      assert.throws(
        () => createDraft(db, 'T', local, 'Seller', { manual: true }),
        (error: unknown) => error instanceof OutreachError && error.code === 'undeliverable_address',
      )
      assert.throws(
        () => createDraft(db, 'T', local, 'Seller'),
        (error: unknown) => error instanceof OutreachError && error.code === 'undeliverable_address',
      )
      assert.equal(manualDraftBlockReason(db, 'T', local), 'undeliverable_address')
      assert.equal(draftBlockReason(db, 'T', local), 'undeliverable_address')
      assert.equal(db.prepare('SELECT to_email FROM outreach_messages WHERE lead_id = ?').get(local), undefined)
    })
  }

  for (const local of ['dana.ruiz', 'info', 'sales']) {
    await t.test(`a manually requested draft is still allowed for ${local}`, () => {
      const address = `${local}@shop.example`
      addLead.run(local, job, address)
      createDraft(db, 'T', local, 'Seller', { manual: true })
      assert.deepEqual(db.prepare('SELECT to_email FROM outreach_messages WHERE lead_id = ?').get(local), {
        to_email: address,
      })
    })
  }
})

test('#1793 draft refusal exposes a plain API reason', () => {
  const route = readFileSync(new URL('../app/api/outreach/route.ts', import.meta.url), 'utf8')
  assert.match(
    route,
    /undeliverable_address: \[422, 'This mailbox is reserved for automated or undeliverable messages\. Find another published contact\.'\]/,
  )
})
