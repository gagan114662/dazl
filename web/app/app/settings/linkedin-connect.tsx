'use client'
// One-click Connect LinkedIn (#1037, #1122). Settings asks the server for a one-time pairing code (with this browser's time zone, for the
// reading hours) and hands it to the dazl Connect extension, which then reads the LinkedIn pages dazl asks for in this browser. dazl stores
// no LinkedIn session and nothing is pasted. Without the extension installed, the page says how to get it.
import { useState } from 'react'
import { CONNECT_EXTENSION_IDS, CONNECT_EXTENSION_URL } from '@/lib/advanced/connect-extension'

export interface ConnectState { connected: boolean; name: string | null; synced_at: number | null; pairing_pending: boolean }
type Runtime = { sendMessage: (id: string, msg: unknown, cb: (r: unknown) => void) => void; lastError?: { message?: string } }
const runtime = (): Runtime | null => {
  const c = (globalThis as { chrome?: { runtime?: Runtime } }).chrome
  return c?.runtime && typeof c.runtime.sendMessage === 'function' ? c.runtime : null
}
// Ask one installed build of the extension; null when that ID is not installed (or this browser has no extension API).
function askOne(id: string, msg: unknown, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const rt = runtime()
  if (!rt) return Promise.resolve(null)
  return new Promise(res => {
    const t = setTimeout(() => res(null), timeoutMs)
    try { rt.sendMessage(id, msg, r => { clearTimeout(t); res(rt.lastError ? null : (r && typeof r === 'object' ? r as Record<string, unknown> : null)) }) } catch { clearTimeout(t); res(null) }
  })
}
// Ask the extension: the Web Store build first, then the developer build. null when neither is installed.
async function ask(msg: unknown, timeoutMs = 30_000): Promise<Record<string, unknown> | null> {
  for (const id of CONNECT_EXTENSION_IDS) { const r = await askOne(id, msg, timeoutMs); if (r) return r }
  return null
}

export default function LinkedinConnect({ state, onChange }: { state: ConnectState | null; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [missing, setMissing] = useState(false)

  async function connect() {
    setBusy(true); setMsg(''); setMissing(false)
    try {
      if (!(await ask({ type: 'ping' }, 3000))) { setMissing(true); return }
      const r = await fetch('/api/settings/advanced', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pair', platform: 'linkedin', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) })
      const j = await r.json() as { code?: string; error?: string }
      if (!r.ok || !j.code) { setMsg(j.error || 'Could not start the connection'); return }
      const reply = await ask({ type: 'pair', code: j.code, origin: location.origin })
      if (!reply) setMsg('The dazl Connect extension did not answer. Open it once, then try again.')
      else if (reply.ok !== true) setMsg(typeof reply.error === 'string' ? reply.error : 'The extension could not connect')
      onChange()
    } finally { setBusy(false) }
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
          <span>Connected. dazl Connect reads LinkedIn in this browser{state.name ? <> as <strong>{state.name}</strong></> : ''}.</span>
          <button disabled={busy} className="underline underline-offset-2 w-fit" onClick={disconnect}>Disconnect</button>
        </div>
      ) : (
        <>
          <button disabled={busy} onClick={connect} className="btn-primary w-fit disabled:opacity-40">Connect LinkedIn</button>
          <p className="text-[#555]">The dazl Connect extension opens the LinkedIn pages dazl needs in a background tab of this browser, with your own sign-in, and reads names and job titles. dazl never gets your LinkedIn password or cookies.</p>
        </>
      )}
      {missing && (
        <p className="text-[#555]" data-testid="install-extension">First install the <a className="underline underline-offset-2" href={CONNECT_EXTENSION_URL} target="_blank" rel="noreferrer">dazl Connect extension</a> (Chrome), sign in to LinkedIn in this browser, then click Connect LinkedIn again.</p>
      )}
      {msg && <p className="text-[#555]" role="status">{msg}</p>}
    </div>
  )
}
