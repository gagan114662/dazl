import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'
import { graphStore } from '@/lib/accounts/cooldown'
import { addRelationship, exclusionsEnabled, listRelationships, removeRelationship, RelationshipError, RELATIONSHIP_STATUSES, type RelationshipStatus } from '@/lib/accounts/relationships'

// The workspace's own customer / open-deal list (lib/accounts/relationships.ts, #364). Every change is a person's explicit
// action ("Already a customer"): nothing is added from lead stages or a CRM. Removal is reversible (the entry is kept,
// stamped). exclusions_active says whether entries currently hold new first touches (DAZL_ACCOUNT_EXCLUSIONS).
const ERR: Record<RelationshipError['code'], [number, string]> = {
  invalid: [400, 'Give an account or a website domain, and customer or open_deal'],
  account_not_found: [404, 'Account not found'],
  not_found: [404, 'Entry not found'],
  already_listed: [409, 'This account or domain is already on your list'],
}
const fail = (e: unknown) => {
  if (e instanceof RelationshipError) { const [s, m] = ERR[e.code]; return NextResponse.json({ error: m, code: e.code }, { status: s }) }
  throw e
}

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'read'); if (no) return no
  const all = req.nextUrl.searchParams.get('all') === '1'
  const entries = await listRelationships(await graphStore(getScanDb()), user.tenantId, { includeRemoved: all })
  return NextResponse.json({ entries, exclusions_active: exclusionsEnabled() })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const b = await req.json().catch(() => null) as { account_id?: unknown; domain?: unknown; status?: unknown; note?: unknown } | null
  if (!b || !RELATIONSHIP_STATUSES.includes(b.status as RelationshipStatus)) return NextResponse.json({ error: ERR.invalid[1], code: 'invalid' }, { status: 400 })
  try {
    const entry = await addRelationship(await graphStore(getScanDb()), user.tenantId, {
      accountId: typeof b.account_id === 'string' ? b.account_id : undefined, domain: typeof b.domain === 'string' ? b.domain : undefined,
      status: b.status as RelationshipStatus, note: typeof b.note === 'string' ? b.note : null,
    }, `member:${user.actorId}`)
    return NextResponse.json({ entry, exclusions_active: exclusionsEnabled() }, { status: 201 })
  } catch (e) { return fail(e) }
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const b = await req.json().catch(() => null) as { id?: unknown } | null
  if (typeof b?.id !== 'string' || !/^[a-f0-9]{24}$/.test(b.id)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try { await removeRelationship(await graphStore(getScanDb()), user.tenantId, b.id, `member:${user.actorId}`); return NextResponse.json({ ok: true }) } catch (e) { return fail(e) }
}
