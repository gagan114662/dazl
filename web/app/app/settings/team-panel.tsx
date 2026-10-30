'use client'
import { useEffect, useState } from 'react'

type Role = 'owner' | 'admin' | 'operator' | 'viewer'
interface Workspace { tenant_id: string; name: string; kind: string; role: Role }
interface Member { member_id: string; email: string; name: string | null; role: Role }
interface Invite { id: string; email: string; role: Role; expires_at: number }

const ROLES: Role[] = ['viewer', 'operator', 'admin', 'owner']
const ROLE_HELP: Record<Role, string> = { viewer: 'reads and exports', operator: 'also runs scans and sends', admin: 'also keys, connectors and members', owner: 'also billing and owners' }
const ERRORS: Record<string, string> = { last_owner: 'A workspace needs at least one owner.', only_workspace: 'That is their only workspace, so it cannot be left or removed.', forbidden: 'Your role cannot do that.', already_member: 'Already a member.', too_many_invites: 'Too many pending invitations.', not_found: 'Not found.' }
const rank = (r: Role) => ROLES.indexOf(r)

type WorkspaceInfo = { current: { tenant_id: string; role: Role }; you: { id: string }; workspaces: Workspace[] }
const getJson = (path: string) => fetch(path).then(r => r.ok ? r.json() : null).catch(() => null)
async function fetchTeam(): Promise<{ ws: WorkspaceInfo | null; members: Member[]; invites: Invite[] }> {
  const ws: WorkspaceInfo | null = await getJson('/api/workspace')
  if (!ws) return { ws, members: [], invites: [] }
  const members = (await getJson('/api/workspace/members'))?.members ?? []
  const invites = rank(ws.current.role) >= rank('admin') ? (await getJson('/api/workspace/invitations'))?.invitations ?? [] : []
  return { ws, members, invites }
}

export default function TeamPanel() {
  const [ws, setWs] = useState<WorkspaceInfo | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [link, setLink] = useState('')
  const [msg, setMsg] = useState('')

  function load() {
    void fetchTeam().then(t => { setWs(t.ws); setMembers(t.members); setInvites(t.invites) })
  }
  useEffect(load, [])

  async function send(path: string, method: string, body: unknown) {
    setMsg('')
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) setMsg(ERRORS[j.error] ?? j.error ?? 'Something went wrong')
    return r.ok ? j : null
  }
  async function switchTo(tenant_id: string) { if (await send('/api/workspace/switch', 'POST', { tenant_id })) window.location.reload() }
  async function invite() {
    const j = await send('/api/workspace/invitations', 'POST', { email, role })
    if (j) { setLink(j.link); setEmail(''); load() }
  }

  if (!ws) return null
  const mine = ws.current.role, admin = rank(mine) >= rank('admin'), owner = mine === 'owner'
  const current = ws.workspaces.find(w => w.tenant_id === ws.current.tenant_id)
  return (
    <div className="card p-6 mb-4">
      <h2 className="font-semibold mb-1">Team</h2>
      <p className="text-[#555] text-sm mb-3">You are <span className="font-medium">{mine}</span> in {current?.kind === 'personal' && current.tenant_id === ws.you.id ? 'your own workspace' : `${current?.name || 'this workspace'}`}: {ROLE_HELP[mine]}.</p>
      {ws.workspaces.length > 1 && (
        <div className="text-sm mb-4">
          <label className="block text-xs text-gray-500 mb-1">Workspace</label>
          <select className="field" value={ws.current.tenant_id} onChange={e => void switchTo(e.target.value)}>
            {ws.workspaces.map(w => <option key={w.tenant_id} value={w.tenant_id}>{(w.tenant_id === ws.you.id ? 'Your workspace' : w.name || 'Workspace')} ({w.role})</option>)}
          </select>
        </div>
      )}
      <ul className="text-sm divide-y divide-[var(--line)] mb-3">
        {members.map(m => (
          <li key={m.member_id} className="flex items-center justify-between gap-3 py-2">
            <span className="truncate">{m.email}{m.member_id === ws.you.id ? ' (you)' : ''}</span>
            <span className="flex items-center gap-3 shrink-0">
              {admin && m.member_id !== ws.you.id && (owner || m.role !== 'owner') ? (
                <select className="field" value={m.role} onChange={async e => { if (await send('/api/workspace/members', 'PATCH', { member_id: m.member_id, role: e.target.value })) load() }}>
                  {ROLES.filter(r => owner || r !== 'owner').map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              ) : <span className="text-[#555]">{m.role}</span>}
              {admin && m.member_id !== ws.you.id && (owner || m.role !== 'owner') && <button className="underline underline-offset-2" onClick={async () => { if (await send('/api/workspace/members', 'DELETE', { member_id: m.member_id })) load() }}>Remove</button>}
            </span>
          </li>
        ))}
      </ul>
      {admin && (
        <div className="text-sm space-y-2">
          <div className="flex flex-wrap gap-2">
            <input className="field flex-1 min-w-0" type="email" placeholder="teammate@company.com" value={email} onChange={e => setEmail(e.target.value)} />
            <select className="field" value={role} onChange={e => setRole(e.target.value as Role)}>{ROLES.filter(r => owner || r !== 'owner').map(r => <option key={r} value={r}>{r}</option>)}</select>
            <button className="btn-primary" disabled={!email.trim()} onClick={() => void invite()}>Invite</button>
          </div>
          {link && <p className="text-[#555]">Send this one-time link to them (it works for 7 days, only for that email, and is shown only now): <code className="break-all select-all">{link}</code></p>}
          {invites.length > 0 && (
            <ul className="divide-y divide-[var(--line)]">
              {invites.map(i => <li key={i.id} className="flex justify-between py-2"><span className="truncate">{i.email} ({i.role}, pending)</span><button className="underline underline-offset-2" onClick={async () => { if (await send('/api/workspace/invitations', 'DELETE', { id: i.id })) load() }}>Revoke</button></li>)}
            </ul>
          )}
        </div>
      )}
      {!(current?.tenant_id === ws.you.id) && <button className="underline underline-offset-2 text-sm mt-3" onClick={async () => { if (await send('/api/workspace/leave', 'POST', {})) window.location.reload() }}>Leave this workspace</button>}
      {msg && <p className="text-sm text-[#555] mt-2">{msg}</p>}
    </div>
  )
}
