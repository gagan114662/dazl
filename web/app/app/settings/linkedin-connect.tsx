'use client'
// One-click Connect LinkedIn (#1037, F-go step 2). Settings asks the server for a one-time pairing code and hands it to the dazl Connect
// extension; the extension reads the user's own LinkedIn session from this browser and saves it. Nothing is pasted. Without the extension
// installed, the page says how to get it. The paste box stays behind "Advanced: paste a session", for testing.
import { useState } from 'react'
import { CONNECT_EXTENSION_ID, CONNECT_EXTENSION_URL } from '@/lib/advanced/connect-extension'

export interface ConnectState { connected: boolean; name: string | null; synced_at: number | null; pairing_pending: boolean }
type Runtime = { sendMessage: (id: string, msg: unknown, cb: (r: unknown) => void) => void; lastError?: { message?: string } }
const runtime = (): Runtime | null => {
  const c = (globalThis as { chrome?: { runtime?: Runtime } }).chrome
  return c?.runtime && typeof c.runtime.sendMessage === 'function' ? c.runtime : null
}
// Ask the extension; null when it is not installed (or this browser has no extension API).
function ask(msg: unknown, timeoutMs = 30_000): Promise<Record<string, unknown> | null> {
  const rt = runtime()
  if (!rt) return Promise.resolve(null)
  return new Promise(res => {
    const t = setTimeout(() => res(null), timeoutMs)
    try { rt.sendMessage(CONNECT_EXTENSION_ID, msg, r => { clearTimeout(t); res(rt.lastError ? null : (r && typeof r === 'object' ? r as Record<string, unknown> : null)) }) } catch { clearTimeout(t); res(null) }
  })
}

export default function LinkedinConnect({ state, enabled, onToggle, onChange, pasteForm }: { state: ConnectState | null; enabled: boolean; onToggle: () => void; onChange: () => void; pasteForm: React.ReactNode }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [missing, setMissing] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  async function connect() {
    setBusy(true); setMsg(''); setMissing(false)
    try {
      if (!(await ask({ type: 'ping' }, 3000))) { setMissing(true); return }
      const r = await fetch('/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pair', platform: 'linkedin' }) })
      const j = await r.json() as { code?: string; error?: string }
      if (!r.ok || !j.code) { setMsg(j.error || 'Could not start the connection'); return }
      const reply = await ask({ type: 'pair', code: j.code, origin: location.origin })
      if (!reply) setMsg('The dazl Connect extension did not answer. Open it once, then try again.')
      else if (reply.ok !== true) setMsg(typeof reply.error === 'string' ? reply.error : 'The extension could not connect')
      onChange()
    } finally { setBusy(false) }
  }
  async function test() {
    setBusy(true); setMsg('')
    const r = await fetch('/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test', platform: 'linkedin' }) })
    const j = await r.json() as { ok?: boolean; name?: string; outcome?: string; error?: string }
    setMsg(j.ok ? `Working: signed in as ${j.name}` : j.error || (j.outcome === 'auth_failed' ? 'LinkedIn signed this session out. Sign in to LinkedIn in this browser; the extension reconnects by itself.' : `The check did not pass (${j.outcome ?? 'error'})`))
    setBusy(false); onChange()
  }
  async function disconnect() {
    setBusy(true)
    await fetch('/api/settings/advanced?platform=linkedin', { method: 'DELETE' })
    await ask({ type: 'forget' }, 3000)
    setBusy(false); setMsg(''); onChange()
  }

  return (
    <div className="flex flex-col gap-2" data-testid="linkedin-connect">
      {state?.connected ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span>Connected as <strong>{state.name ?? 'your LinkedIn account'}</strong>{state.synced_at ? `, synced ${new Date(state.synced_at * 1000).toLocaleString()}` : ''}, <span data-testid="linkedin-enabled">{enabled ? 'on' : 'off'}</span>{!enabled ? ' (switched off: dazl reads nothing until you turn it on)' : ''}</span>
          <span className="flex gap-4">
            <button disabled={busy} className="underline underline-offset-2" onClick={onToggle}>{enabled ? 'Turn off' : 'Turn on'}</button>
            <button disabled={busy} className="underline underline-offset-2" onClick={test}>Test connection</button>
            <button disabled={busy} className="underline underline-offset-2" onClick={disconnect}>Disconnect</button>
          </span>
        </div>
      ) : (
        <>
          <button disabled={busy} onClick={connect} className="btn-primary w-fit disabled:opacity-40">Connect LinkedIn</button>
          <p className="text-[#555]">Uses the LinkedIn account you are signed in to in this browser, through the dazl Connect extension. It reads only your LinkedIn session, nothing else.</p>
        </>
      )}
      {missing && (
        <p className="text-[#555]" data-testid="install-extension">First install the <a className="underline underline-offset-2" href={CONNECT_EXTENSION_URL} target="_blank" rel="noreferrer">dazl Connect extension</a> (Chrome), sign in to LinkedIn in this browser, then click Connect LinkedIn again.</p>
      )}
      {msg && <p className="text-[#555]" role="status">{msg}</p>}
      {!state?.connected && (advanced ? pasteForm : <button className="text-xs underline underline-offset-2 w-fit text-[#555]" onClick={() => setAdvanced(true)}>Advanced: paste a session</button>)}
    </div>
  )
}
