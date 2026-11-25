import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { denied, stale } from '@/lib/workspace-access'

// #1703: dazl runs every search on its own AI account, so an account no longer adds, sees or removes a key of its own.
// The route stays so a screen or script still calling it gets a plain answer rather than a 404 or 405. It reads,
// writes and removes nothing: a key saved before stays where it is until its removal is decided separately. The
// sign-in, role and fresh-session checks still come first, so a caller refused before is refused the same way now.
const GONE = 'dazl runs every search on its own AI account, so there is nothing to add here.'
const gone = () => NextResponse.json({ error: GONE }, { status: 410 })

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return gone()
}

export async function PUT() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  return gone()
}

export async function DELETE() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  return gone()
}
