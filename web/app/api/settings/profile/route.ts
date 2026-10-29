import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { readBusinessName, readBuyerProfile, readSellerProfile, writeBusinessName, writeBuyerProfile, writeSellerProfile } from '@/lib/auth-db'
import { getDb } from '@/lib/db/client'
import type { Db } from '@/lib/db/client'
import { normalizeIcp } from '@/lib/scan/icp'
import { rateLimit } from '@/lib/rate-limit'
import { audited, denied } from '@/lib/workspace-access'

// The stored buyer profile, re-normalized on the way out (null when none is saved or it no longer validates).
async function buyer(db: Db, userId: string) {
  const raw = await readBuyerProfile(db, userId)
  if (!raw) return null
  try { return normalizeIcp(JSON.parse(raw)) } catch { return null }
}

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  return NextResponse.json({ ...await readSellerProfile(db, user.tenantId), business_name: await readBusinessName(db, user.tenantId), buyer: await buyer(db, user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'configure'); if (no) return no
  const done = audited(user, 'settings.changed', 'profile')
  if (!(await rateLimit(`profile:${user.tenantId}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = await getDb()
  const cur = await readSellerProfile(db, user.tenantId)
  // Fields the caller omits keep their stored value (a name-only save must not wipe sells/website).
  const sells = typeof body?.sells === 'string' ? body.sells.trim().slice(0, 150) : cur.sells
  const website = typeof body?.website === 'string' ? body.website.trim().slice(0, 200) : cur.website
  // Optional buyer profile (who they sell to). Omitted keeps the stored one, null clears it, anything else must pass the
  // same normalizeIcp validation a scan profile does - an invalid one is refused, never silently stored or dropped.
  let buyerJson: string | null | undefined
  if (body && typeof body === 'object' && 'buyer' in body) {
    if (body.buyer === null) buyerJson = null
    else {
      const icp = normalizeIcp(body.buyer)
      if (!icp) return NextResponse.json({ error: 'The buyer profile needs a description of who buys' }, { status: 400 })
      buyerJson = JSON.stringify(icp)
    }
  }
  if (website && !/^https:\/\/[\w.-]+\.[a-z]{2,}([/?#]\S*)?$/i.test(website)) return NextResponse.json({ error: 'Website must be a full https URL, like https://acme.com' }, { status: 400 })
  await writeSellerProfile(db, user.tenantId, sells, website)
  if (buyerJson !== undefined) await writeBuyerProfile(db, user.tenantId, buyerJson)
  // Optional: the name used in drafts. Only changed when the caller sends it; blank clears it (drafts then refuse).
  if (typeof body?.business_name === 'string') await writeBusinessName(db, user.tenantId, body.business_name)
  // Return the canonical stored values so the page never shows text the server did not keep.
  return done({ ok: true, ...await readSellerProfile(db, user.tenantId), business_name: await readBusinessName(db, user.tenantId), buyer: await buyer(db, user.tenantId) })
}
