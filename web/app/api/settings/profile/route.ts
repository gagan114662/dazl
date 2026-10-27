import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getAuthDb, getBusinessName, getSellerProfile, setBusinessName, setSellerProfile } from '@/lib/auth-db'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ ...getSellerProfile(getAuthDb(), user.id), business_name: getBusinessName(getAuthDb(), user.id) })
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
  if (website && !/^https:\/\/[\w.-]+\.[a-z]{2,}([/?#]\S*)?$/i.test(website)) return NextResponse.json({ error: 'Website must be a full https URL, like https://acme.com' }, { status: 400 })
  setSellerProfile(getAuthDb(), user.id, sells, website)
  // Optional: the name used in drafts. Only changed when the caller sends it; blank clears it (drafts then refuse).
  if (typeof body?.business_name === 'string') setBusinessName(getAuthDb(), user.id, body.business_name)
  // Return the canonical stored values so the page never shows text the server did not keep.
  return NextResponse.json({ ok: true, ...getSellerProfile(getAuthDb(), user.id), business_name: getBusinessName(getAuthDb(), user.id) })
}
