import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getAuthDb, getSellerProfile, setSellerProfile } from '@/lib/auth-db'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(getSellerProfile(getAuthDb(), user.id))
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!rateLimit(`profile:${user.id}`, 20, 60_000).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const sells = typeof body?.sells === 'string' ? body.sells.trim().slice(0, 150) : ''
  let website = typeof body?.website === 'string' ? body.website.trim().slice(0, 200) : ''
  if (website && !/^https:\/\/[\w.-]+\.[a-z]{2,}([/?#]\S*)?$/i.test(website)) return NextResponse.json({ error: 'Website must be a full https URL, like https://acme.com' }, { status: 400 })
  setSellerProfile(getAuthDb(), user.id, sells, website)
  return NextResponse.json({ ok: true })
}
