import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'

// Per-attempt AI rewrite accounting for the tenant's own review. Counts and token
// numbers are what the provider returned - never a cost guess; the provider bills
// the tenant directly and its console is the source of truth for amounts.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  let attempts: unknown[] = []
  let total = 0
  try {
    attempts = db.prepare('SELECT vendor, model, outcome, input_tokens, output_tokens, created_at FROM outreach_llm_usage WHERE tenant_id = ? ORDER BY id DESC LIMIT 50').all(user.id)
    total = (db.prepare('SELECT COUNT(*) AS n FROM outreach_llm_usage WHERE tenant_id = ?').get(user.id) as { n: number }).n
  } catch { /* usage table may predate this deploy */ }
  return NextResponse.json({ attempts, total })
}
