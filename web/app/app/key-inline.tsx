'use client'
import { useState } from 'react'
import { vendorForKey } from '@/lib/onboarding'

// One field: paste an Anthropic or OpenAI key, the prefix picks the provider. The server checks the key with the
// provider before saving it (same PUT /api/settings/llm-key as Settings), so a bad key is never stored.
//
// Deliberately NOT a form element: KeyInline also renders inside other forms (the first-run brain and ask steps),
// and the HTML parser drops a nested form tag - the field and button then belong to the OUTER form, so 'Save key' submitted
// that form natively (POST /app): the React save never ran, no llm-key PUT went out and the page state was lost
// (#409, confirmed live on 40e7bf30). A div + an explicit type="button" click + Enter on the field keeps the same
// keyboard flow and can never be captured by an ancestor form, whatever placement KeyInline is given next.
export default function KeyInline({ reason, onSaved }: { reason: string; onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const vendor = vendorForKey(key)
  async function save() {
    if (busy) return
    if (!vendor) return setMsg('Paste a key that starts with sk-ant- (Anthropic) or sk- (OpenAI).')
    setBusy(true); setMsg('Checking your key with the provider...')
    try {
      const r = await fetch('/api/settings/llm-key', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vendor, api_key: key.trim() }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return setMsg(j.error || 'Could not save the key')
      setKey(''); setMsg(''); onSaved()
    } catch { setMsg('Could not reach the server. Try again.') } finally { setBusy(false) }
  }
  return (
    <div className="border border-black/10 rounded-lg p-4 bg-[#fafafa] text-sm">
      <label htmlFor="ai-key" className="font-medium block mb-1">Your AI key</label>
      <p className="text-[#555] text-xs mb-2">{reason} Your provider bills you for usage. The key is encrypted and never shown again.{' '}
        <a className="underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">Get an Anthropic key</a> or{' '}
        <a className="underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">an OpenAI key</a>.</p>
      <div className="flex gap-2">
        <input id="ai-key" className="field flex-1" type="password" autoComplete="off" placeholder="sk-ant-... or sk-..." value={key} onChange={e => setKey(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save() } }} />
        <button type="button" className="btn-ghost text-sm" disabled={busy || key.trim().length < 10} onClick={() => void save()}>{busy ? 'Checking...' : 'Save key'}</button>
      </div>
      {msg && <p className="text-xs text-[#555] mt-2" role="status">{msg}</p>}
    </div>
  )
}
