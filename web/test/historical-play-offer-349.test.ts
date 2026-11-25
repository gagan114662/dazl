import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveMemory } from '../lib/memory.ts'
import { readPlayOffer } from '../lib/scan/play-offer.ts'
import { draftOffer } from '../lib/scan/play-offer-text.ts'
import { createQueryJob } from '../lib/scan/store.ts'

test('#349 an identity-only historical request keeps its recorded offer for play readback and drafting', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const tenant = 'historical-offer'
    db.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tenant, 'historical@example.test', 'Fixture', 'Fixture', 'x', 'y')
    const positioning = 'Bookkeeping and payroll services'
    const current = 'Inventory planning'
    const query = 'I run a small agency. Find expanding businesses'
    const seller = positioning + ' - https://seller.example.test'
    const job = createQueryJob(db, tenant, { query, seller })
    saveMemory(db, tenant, { positioning: current })

    assert.deepEqual(await readPlayOffer(db, tenant, job), { offer: positioning, source: 'recorded', conflict: null })
    assert.deepEqual(draftOffer({ seller, query }, current), { offer: positioning, refuse: null })
  } finally {
    db.close()
  }
})
