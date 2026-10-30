// @/lib/auth-db for the POST /api/scan harness: no file is opened. The seller line (the business profile's offer) is
// empty unless a test sets it per tenant.
const lines = new Map<string, string>()
export function setSellerLine(userId: string, line: string): void { lines.set(userId, line) }
export function getAuthDb(): null { return null }
export function sellerProfile(_db: unknown, userId?: string): string { return (userId && lines.get(userId)) || '' }
