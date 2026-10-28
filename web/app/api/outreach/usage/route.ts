import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'

// Per-attempt AI rewrite accounting for the tenant's own review. Counts and token
// numbers are what the provider returned - never a cost guess; the provider bills
// the tenant directly and its console is the source of truth for amounts.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  let attempts: unknown[] = []
  let total = 0
  try {
    attempts = await db.all('SELECT vendor, model, outcome, input_tokens, output_tokens, created_at FROM outreach_llm_usage WHERE tenant_id = ? ORDER BY id DESC LIMIT 50', [user.id])
    total = Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outreach_llm_usage WHERE tenant_id = ?', [user.id]))!.n)
  } catch { /* usage table may predate this deploy */ }
  return NextResponse.json({ attempts, total })
}
