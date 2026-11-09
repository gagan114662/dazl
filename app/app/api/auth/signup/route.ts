import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { randomBytes, scryptSync } from 'crypto'
import { cookies } from 'next/headers'
import path from 'path'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), '..', '..', 'dazl-data', 'app.db')

function getDb() {
  const db = new Database(DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      business_name TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `)
  return db
}

export async function POST(req: NextRequest) {
  try {
    const { email, name, business_name, password } = await req.json()
    if (!email || !password) return NextResponse.json({ error: 'Email and password required' }, { status: 400 })

    const db = getDb()
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    const id = randomBytes(16).toString('hex')

    db.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email.toLowerCase(), name || '', business_name || '', hash, salt)

    const sessionId = randomBytes(32).toString('hex')
    const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sessionId, id, expires)

    const cookieStore = await cookies()
    cookieStore.set('dazl_session', sessionId, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 60*60*24*30, path: '/' })

    return NextResponse.json({ ok: true, redirect: '/app' })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) return NextResponse.json({ error: 'Email already registered' }, { status: 409 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
