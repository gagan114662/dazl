import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { removeKey, readKeyStatus, writeKey } from '@/lib/llm/key-store'
import { openKeyRejection } from '@/lib/llm/key-evidence'
import { isVendor, looksLikeKey, validateKey } from '@/lib/llm/vendors'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'

// Status only: vendor, last 4 characters and when it was validated. The key itself is never returned. rejection: a later
// scan that stopped on this account's key with no acceptance of that same key since (lib/llm/key-evidence.ts); read-only.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  return NextResponse.json({ keys: await readKeyStatus(db, user.id), rejection: await openKeyRejection(db, user.id) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = (await rateLimit(`llmkey:${user.id}`, 10, 60 * 60 * 1000))
  if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })

  const body = await req.json().catch(() => null)
  const vendor = body?.vendor
  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  if (!isVendor(vendor) || !looksLikeKey(vendor, apiKey)) return NextResponse.json({ error: 'That does not look like a valid key for this provider' }, { status: 400 })
  if (!process.env.DAZL_MASTER_KEY) {
    console.error('DAZL_MASTER_KEY is not configured')
    return NextResponse.json({ error: 'Key storage is not available right now' }, { status: 503 })
  }

  const detail: { message?: string } = {}
  const check = await validateKey(vendor, apiKey, fetch, detail)
  if (check === 'invalid') return NextResponse.json({ error: 'The provider rejected this key' }, { status: 400 })
  if (check === 'rejected') return NextResponse.json({ error: `The provider could not use this key${detail.message ? ': ' + detail.message : '.'}` }, { status: 400 })
  if (check === 'unavailable') return NextResponse.json({ error: 'Could not reach the provider to check the key. Try again.' }, { status: 502 })

  await writeKey(await getDb(), user.id, vendor, apiKey)
  return NextResponse.json({ ok: true, vendor, last4: apiKey.slice(-4) })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const vendor = req.nextUrl.searchParams.get('vendor')
  if (!isVendor(vendor)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ ok: await removeKey(await getDb(), user.id, vendor) })
}
