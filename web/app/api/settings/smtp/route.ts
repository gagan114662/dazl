import { NextRequest, NextResponse } from 'next/server'
import { audit } from '@/lib/audit-route'
import { getDb } from '@/lib/db/client'
import { verifySmtpMailbox } from '@/lib/email/smtp-connect'
import { disconnectSmtpMailbox, saveSmtpMailbox, smtpMailboxStatus } from '@/lib/email/smtp-store'
import { sameOriginJson } from '@/lib/same-origin'
import { requireUser } from '@/lib/scan/service'
import { denied, stale } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ mailbox: await smtpMailboxStatus(await getDb(), user.tenantId) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const body: unknown = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid SMTP settings' }, { status: 400 })
  const { host, port, username, password } = body as Record<string, unknown>
  if (typeof host !== 'string' || host.length > 253 || (port !== 465 && port !== 587)
    || typeof username !== 'string' || !username.trim() || username.length > 320
    || typeof password !== 'string' || !password || password.length > 1024) {
    return NextResponse.json({ error: 'Invalid SMTP settings' }, { status: 400 })
  }

  const mailbox = { host: host.trim().toLowerCase(), port, username: username.trim(), password }
  try {
    await verifySmtpMailbox(mailbox)
  } catch {
    return NextResponse.json({ error: 'Could not verify the SMTP mailbox' }, { status: 422 })
  }
  const id = await saveSmtpMailbox(await getDb(), user.tenantId, mailbox)
  await audit(user, req, { action: 'credential.saved', resource: 'smtp', id })
  return NextResponse.json({ mailbox: { id, host: mailbox.host, port, username: mailbox.username } })
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })

  const body = await req.json().catch(() => null) as { id?: unknown } | null
  const id = body?.id
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!await disconnectSmtpMailbox(await getDb(), user.tenantId, id)) {
    return NextResponse.json({ error: 'connection_changed' }, { status: 409 })
  }
  await audit(user, req, { action: 'credential.removed', resource: 'smtp', id })
  return NextResponse.json({ ok: true })
}
