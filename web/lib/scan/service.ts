import { cookies } from 'next/headers'
import { getAuthDb, getSessionUser } from '../auth-db'
import { migrateScan } from './store.ts'

let ready = false
export function getScanDb() {
  const db = getAuthDb()
  if (!ready) {
    migrateScan(db)
    ready = true
  }
  return db
}

export async function requireUser() {
  return getSessionUser((await cookies()).get('dazl_session')?.value)
}
