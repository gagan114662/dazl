'use client'
import { useEffect, useState } from 'react'
import { can, isRole, type Action, type Role } from '../../lib/workspaces.ts'

// #833: the signed-in member's role in the current workspace (GET /api/workspace), so a page can hide the controls that
// role cannot use. The server still refuses them (403); this only stops showing a viewer buttons that would fail.
// While the role is unknown (loading, or the read failed) the controls stay shown and the server decides.
export function showsAction(role: unknown, action: Action): boolean {
  return !isRole(role) || can(role, action)
}

export function useRole(): Role | null {
  const [role, setRole] = useState<Role | null>(null)
  useEffect(() => {
    let live = true
    fetch('/api/workspace').then(r => r.ok ? r.json() : null).then(j => { if (live && isRole(j?.current?.role)) setRole(j.current.role) }).catch(() => {})
    return () => { live = false }
  }, [])
  return role
}
