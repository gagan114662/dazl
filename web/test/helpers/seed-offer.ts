import type Database from 'better-sqlite3'
import { migrateMemory, saveMemory } from '../../lib/memory.ts'

// Synthetic seller offer for fixtures: drafts now require a saved offer, so test tenants get one explicitly.
export const SEEDED_OFFER = 'Synthetic test offer: software that tracks public sales signals.'
export function seedOffers(db: Database.Database, tenants: string[] = ['A', 'B']): void {
  migrateMemory(db)
  for (const t of tenants) saveMemory(db, t, { positioning: SEEDED_OFFER })
}
