import { NextRequest, NextResponse } from 'next/server'
import { scryptSync, timingSafeEqual } from 'crypto'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'
import { CONFIRM_PHRASE, requestDeletion, withdrawDeletion } from '@/lib/tenant/requests'

// Ask for the account to be deleted (issue #359). This RECORDS the request only: no data, session or sign-in changes.
// An operator carries it out (scripts/tenant-requests.mts) under an explicit retention policy. The person must type the
// phrase and their account email, and give their password when the account has one (not Google-only).
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const rl = await rateLimit(`deletion:${user.id}`, 10, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const body = await req.json().catch(() => null)
  const db = await getDb()
  const acct = await db.get<{ email: string; password_hash: string; salt: string }>('SELECT email, password_hash, salt FROM users WHERE id = ?', [user.id])
  if (!acct) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (typeof body?.confirm !== 'string' || body.confirm.trim().toLowerCase() !== CONFIRM_PHRASE) return NextResponse.json({ error: `Type "${CONFIRM_PHRASE}" to confirm` }, { status: 400 })
  if (typeof body?.email !== 'string' || body.email.trim().toLowerCase() !== acct.email.toLowerCase()) return NextResponse.json({ error: 'Type your account email to confirm' }, { status: 400 })
  const googleOnly = !!(await db.get("SELECT 1 AS x FROM oauth_identities WHERE user_id = ? AND provider = 'google'", [user.id]))
  if (!googleOnly) {
    const pw = typeof body?.password === 'string' && body.password.length <= 200 ? body.password : ''
    const ok = !!pw && timingSafeEqual(scryptSync(pw, acct.salt, 64), Buffer.from(acct.password_hash, 'hex'))
    if (!ok) return NextResponse.json({ error: 'Your password is not right' }, { status: 403 })
  }
  const r = await requestDeletion(db, user.id)
  if ('refused' in r) return NextResponse.json({ error: r.refused }, { status: 409 })
  return NextResponse.json({ ok: true, request: { id: r.id, status: r.status, requested_at: Number(r.requested_at) } })
}

// Withdraw the account's own pending request.
export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (req.headers.get('origin') && new URL(req.headers.get('origin')!).host !== req.headers.get('host')) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ ok: await withdrawDeletion(await getDb(), user.id) })
}
