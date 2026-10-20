import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { scryptSync, timingSafeEqual } from 'crypto'
import { randomBytes } from 'crypto'
import { cookies } from 'next/headers'
import path from 'path'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), '..', '..', 'dazl-data', 'app.db')

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) return NextResponse.json({ error: 'Email and password required' }, { status: 400 })

    const db = new Database(DB_PATH)
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as Record<string,string> | undefined
    if (!user) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })

    const hash = scryptSync(password, user.salt, 64)
    const stored = Buffer.from(user.password_hash, 'hex')
    if (!timingSafeEqual(hash, stored)) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })

    const sessionId = randomBytes(32).toString('hex')
    const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, user.id, expires)

    const cookieStore = await cookies()
    cookieStore.set('dazl_session', sessionId, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 60*60*24*30, path: '/' })

    return NextResponse.json({ ok: true, redirect: '/app' })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
