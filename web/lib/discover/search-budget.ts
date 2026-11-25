// A shared allowance for every native search request in one discovery run.
import { scanSpendContext } from '../scan/spend-cap.ts'
import { persistedSearchBudget } from './search-ledger.ts'
export const NATIVE_SEARCH_CEILING = 15
export function searchAllowance(value: unknown = NATIVE_SEARCH_CEILING): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Native search allowance is invalid')
  }
  return Math.min(value, NATIVE_SEARCH_CEILING)
}
export function configuredSearchAllowance(raw: string | undefined): number {
  if (raw === undefined) return NATIVE_SEARCH_CEILING
  if (!/^\d+$/.test(raw)) throw new Error('Native search allowance is invalid')
  return searchAllowance(Number(raw))
}
export async function reserveNativeScanSearches(requested: number): Promise<SearchReservation | null> {
  if (!scanSpendContext()) return null
  const hold = await createSearchBudget().reserve(requested)
  if (hold.allowance === 0) throw new Error('Native search budget exhausted')
  return hold
}
export interface SearchReservation { allowance: number; settle(used: unknown): Promise<void> }
export interface SearchBudget { reserve(requested: number): Promise<SearchReservation> }
export function createSearchBudget(limit = NATIVE_SEARCH_CEILING): SearchBudget {
  let held = 0
  const ceiling = searchAllowance(limit)
  const ctx = scanSpendContext()
  if (ctx) {
    const persisted = persistedSearchBudget(ctx, ceiling)
    return { reserve: requested => persisted.reserve(searchAllowance(requested)) }
  }
  return {
    async reserve(requested) {
      const allowance = Math.min(searchAllowance(requested), ceiling - held)
      held += allowance
      let done = false
      return { allowance, async settle(used) {
        if (done) return
        done = true
        if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 || used > allowance) {
          throw new Error('Native search usage is unavailable; allowance retained')
        }
        held -= allowance - used
      } }
    },
  }
}
