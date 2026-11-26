import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Database from 'better-sqlite3'
import { reviewOffer, websiteReviewOffer } from '../app/app/leads/website-review-offer.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveMemory } from '../lib/memory.ts'
import { readPlayOffer } from '../lib/scan/play-offer.ts'
import { draftOffer } from '../lib/scan/play-offer-text.ts'
import { createQueryJob } from '../lib/scan/store.ts'

const query = 'I run a small agency. Find expanding businesses'

test('#349 an identity-only historical request keeps its recorded offer for play readback and drafting', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const tenant = 'historical-offer'
    db.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tenant, 'historical@example.test', 'Fixture', 'Fixture', 'x', 'y')
    const positioning = 'Bookkeeping and payroll services'
    const current = 'Inventory planning'
    const seller = positioning + ' - https://seller.example.test'
    const job = createQueryJob(db, tenant, { query, seller })
    saveMemory(db, tenant, { positioning: current })

    assert.deepEqual(await readPlayOffer(db, tenant, job), { offer: positioning, source: 'recorded', conflict: null })
    assert.deepEqual(draftOffer({ seller, query }, current), { offer: positioning, refuse: null })
  } finally {
    db.close()
  }
})

const saved = { offer: 'Inventory planning', business: '', seller: 'Inventory planning' }
const choice = { offer: '', conflict: { stated: null, recorded: saved.offer, ambiguous: true } }

test('#349 profile review asks for an offer on an identity-only new request', () => {
  assert.deepEqual(reviewOffer(query, saved), choice)
})

test('#349 website profile review asks for an offer on an identity-only new request', () => {
  assert.deepEqual(websiteReviewOffer(query, saved, saved.offer), choice)
})

test('#349 a bare named business in the request requires its own offer choice', () => {
  assert.deepEqual(reviewOffer('We operate Acme. Find expanding businesses', saved), choice)
})

test('#349 an explicitly stated company product is available for selection', () => {
  assert.deepEqual(reviewOffer('My company offers CRM setup to agencies. Find prospects', saved), {
    offer: 'CRM setup',
    conflict: { stated: 'CRM setup', recorded: saved.offer },
  })
})

test('#349 offer chooser distinguishes a request offer from no saved offer', () => {
  const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(client, /This request says you sell <strong>\{c.stated\}<\/strong>\. Confirm this offer/)
  assert.match(client, /There is no saved offer for this workspace\. Write what this play sells/)
})
