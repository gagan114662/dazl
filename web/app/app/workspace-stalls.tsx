import { cookies } from 'next/headers'
import { connection } from 'next/server'
import { getSessionUser } from '@/lib/auth-db'
import { getDb } from '@/lib/db/client'
import { workspaceStallReasons, WORKSPACE_STALL_COPY } from '@/lib/ops/workspace-stalls'

export default async function WorkspaceStalls() {
  await connection()
  const token = (await cookies()).get('dazl_session')?.value
  if (!token) return null
  const db = await getDb()
  const user = await getSessionUser(token, db)
  if (!user) return null
  const reasons = await workspaceStallReasons(db, user.tenantId)
  if (!reasons.length) return null
  return <aside aria-label="Workspace alerts" className="card mb-5 p-4">
    <h2 className="font-semibold">Your workspace needs attention</h2>
    <ul className="mt-2 space-y-1 text-sm">
      {reasons.map(reason => {
        const item = WORKSPACE_STALL_COPY[reason]
        return <li key={reason}>{item.text} <a className="underline" href={item.href}>{item.action}</a></li>
      })}
    </ul>
  </aside>
}
