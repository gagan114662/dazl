'use client'

import { useEffect, useState, type FormEvent } from 'react'

type MailboxStatus = { id: string; username: string }

async function loadMailbox(signal?: AbortSignal): Promise<MailboxStatus | null> {
  const response = await fetch('/api/settings/smtp', { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Mailbox status unavailable')
  return (await response.json()).mailbox
}

export default function SmtpForm() {
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingMailbox, setLoadingMailbox] = useState(true)
  const [status, setStatus] = useState('')
  const [mailbox, setMailbox] = useState<MailboxStatus | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    loadMailbox(controller.signal).then(setMailbox).catch(() => {
      if (!controller.signal.aborted) setStatus('Could not load mailbox status.')
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingMailbox(false)
    })
    return () => controller.abort()
  }, [])

  async function disconnect() {
    if (!mailbox) return
    setSaving(true)
    setStatus('')
    try {
      const response = await fetch('/api/settings/smtp', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: mailbox.id }),
      })
      if (response.status === 409) {
        setMailbox(await loadMailbox())
        setStatus('The mailbox changed. Review the current connection.')
      } else if (response.ok) {
        setMailbox(null)
        setStatus('Mailbox disconnected.')
      } else {
        const result = await response.json()
        setStatus(result.error === 'reauth_required'
          ? 'Confirm your sign-in before disconnecting the mailbox.'
          : 'Could not disconnect the mailbox.')
      }
    } catch {
      setStatus('Could not disconnect the mailbox. Try again.')
    } finally {
      setSaving(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loadingMailbox || saving) return
    const fields = new FormData(event.currentTarget)
    setSaving(true)
    setStatus('')
    try {
      const response = await fetch('/api/settings/smtp', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: fields.get('host'),
          port: Number(fields.get('port')),
          username: fields.get('username'),
          password,
        }),
      })
      const result = await response.json()
      if (response.ok) {
        setMailbox(result.mailbox)
        setStatus('Mailbox connected.')
      } else if (result.error === 'reauth_required') {
        setStatus('Confirm your sign-in before connecting a mailbox.')
      } else {
        setStatus('Could not connect the mailbox. Check your SMTP settings and app password.')
      }
    } catch {
      setStatus('Could not connect the mailbox. Try again.')
    } finally {
      setPassword('')
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby="smtp-title" className="mt-6 border-t border-[#ddd] pt-6">
      <h2 id="smtp-title" className="font-semibold">Connect a mailbox with SMTP</h2>
      {mailbox && <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <p>Connected as {mailbox.username}</p>
        <button type="button" disabled={saving} onClick={disconnect} className="min-h-11 border px-3 py-2">Disconnect mailbox</button>
      </div>}
      <form method="post" onSubmit={submit} className="mt-3 flex max-w-sm flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">SMTP host
          <input name="host" required maxLength={253} className="border p-2" />
        </label>
        <label className="flex flex-col gap-1">SMTP port
          <select name="port" defaultValue="587" className="border p-2">
            <option value="587">587 (STARTTLS)</option>
            <option value="465">465 (TLS)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">Mailbox username
          <input name="username" required maxLength={320} autoComplete="username" className="border p-2" />
        </label>
        <label className="flex flex-col gap-1">App password
          <input type="password" required maxLength={1024} autoComplete="new-password" value={password}
            onChange={event => setPassword(event.target.value)} className="border p-2" />
        </label>
        <button type="submit" disabled={saving || loadingMailbox} className="min-h-11 self-start border px-3 py-2">
          {saving ? 'Connecting…' : 'Connect mailbox'}
        </button>
        <p role="status">{status}</p>
      </form>
    </section>
  )
}
