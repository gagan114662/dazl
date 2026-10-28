import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getAuthDb, getBusinessName, getBuyerProfile, getSellerProfile, setBusinessName, setBuyerProfile, setSellerProfile } from '@/lib/auth-db'
import { normalizeIcp } from '@/lib/scan/icp'
import { rateLimit } from '@/lib/rate-limit'

// The stored buyer profile, re-normalized on the way out (null when none is saved or it no longer validates).
function buyer(userId: string) {
  const raw = getBuyerProfile(getAuthDb(), userId)
  if (!raw) return null
  try { return normalizeIcp(JSON.parse(raw)) } catch { return null }
}

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ ...getSellerProfile(getAuthDb(), user.id), business_name: getBusinessName(getAuthDb(), user.id), buyer: buyer(user.id) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!(await rateLimit(`profile:${user.id}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const cur = getSellerProfile(getAuthDb(), user.id)
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
  setSellerProfile(getAuthDb(), user.id, sells, website)
  if (buyerJson !== undefined) setBuyerProfile(getAuthDb(), user.id, buyerJson)
  // Optional: the name used in drafts. Only changed when the caller sends it; blank clears it (drafts then refuse).
  if (typeof body?.business_name === 'string') setBusinessName(getAuthDb(), user.id, body.business_name)
  // Return the canonical stored values so the page never shows text the server did not keep.
  return NextResponse.json({ ok: true, ...getSellerProfile(getAuthDb(), user.id), business_name: getBusinessName(getAuthDb(), user.id), buyer: buyer(user.id) })
}
