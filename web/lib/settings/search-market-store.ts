import type { Db } from '../db/client.ts'
import { browserMarket, marketLanguage, type SearchMarket } from '../scan/search-market.ts'
import { isoCountry } from '../scan/icp.ts'

export async function readAccountMarket(db: Db, tenantId: string): Promise<SearchMarket | null> {
  const row = await db.get<{ search_market: string | null }>('SELECT search_market FROM organizations WHERE id = ?', [tenantId]).catch((error: unknown) => {
    // Standalone worker replay databases may contain only scan tables.
    if (db.kind === 'sqlite' && error instanceof Error && error.message === 'no such table: organizations') return undefined
    throw error
  })
  if (!row?.search_market) return null
  const market = JSON.parse(row.search_market) as SearchMarket
  return { country: isoCountry(market.country), language: marketLanguage(market.language) }
}

export async function captureAccountMarket(db: Db, tenantId: string, locale: unknown): Promise<void> {
  const market = browserMarket(locale)
  if (!market.country && !market.language) return
  await db.run('UPDATE organizations SET search_market = ? WHERE id = ? AND search_market IS NULL', [JSON.stringify(market), tenantId])
}

export async function writeAccountMarket(db: Db, tenantId: string, market: SearchMarket): Promise<void> {
  await db.run('UPDATE organizations SET search_market = ? WHERE id = ?', [JSON.stringify(market), tenantId])
}
