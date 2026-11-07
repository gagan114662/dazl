"use client"
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { afterSignIn, keepInvite } from '@/lib/invite-return'
import { ClaimContextBanner, useClaimContext } from '../preview/claim/context-banner'

export default function SignUpForm({ trialFunded }: { trialFunded: boolean }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const claim = useClaimContext()
  // #357: while dazl can mail a link, sign-up does not sign in: the same check_email answer comes back for a new and a
  // taken address, and the app opens after the emailed link is confirmed and the account signs in (the sign-in route
  // then resumes an invitation or preview claim this browser carries). Without mail delivery the route answers as on
  // main and this form continues into the app as before.
  const [sent, setSent] = useState('')

  useEffect(() => { keepInvite() }, [])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true); setError('')
    const fd = new FormData(e.currentTarget)
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fd.get('email'),
        password: fd.get('password'),
        name: fd.get('name'),
        business_name: fd.get('business_name'),
      })
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Signup failed'); setLoading(false); return }
    if (data.check_email === true) { setSent(String(fd.get('email') ?? '')); return }
    router.push(afterSignIn(data.resume))
  }

  // Non-assertive on purpose: the same answer covers a sent link, a taken address (which gets a notice instead), a
  // capped address and a failed send, so the page never claims delivery it cannot know happened.
  if (sent) {
    return (
      <main id="main" tabIndex={-1} className="outline-none min-h-screen flex items-center justify-center glow px-4 py-10">
        <div className="card p-8 sm:p-10 w-full max-w-sm text-center" role="status">
          <Link href="/" className="text-xl font-medium tracking-tight flex items-center min-h-11 mb-4">dazl<span className="text-[#111]">.</span></Link>
          <h1 className="text-2xl font-medium mb-3">Check your email</h1>
          <p className="text-[#555] text-sm mb-4">If <span className="text-[#111]">{sent}</span> can receive mail from us, a link to confirm it is on its way. Open it, then sign in. The link works once, for 24 hours.</p>
          <p className="text-[#555] text-sm mb-4">Nothing arrived? Sign in with your password and we&apos;ll try to send a new link.</p>
          <a href="/sign-in" className="btn-primary inline-block !py-3 px-6">Sign in</a>
        </div>
      </main>
    )
  }

  return (
    <main id="main" tabIndex={-1} className="outline-none min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm">
        <Link href="/" className="text-xl font-medium tracking-tight flex items-center justify-center min-h-11 mb-4">dazl<span className="text-[#111]">.</span></Link>
        <h1 className="text-2xl font-medium mb-1 text-center">Create your account</h1>
        <p className="text-[#555] text-sm mb-6 text-center">
          {trialFunded
            ? 'Free plan: 50 scans a month with your own AI key. New accounts may get 3 trial scans first. Upgrade any time.'
            : 'Free plan: 50 scans a month with your own AI key. Upgrade any time.'}
        </p>
        <ClaimContextBanner business={claim.business} action="Create your account" />
        <a href={claim.googleHref} className="flex items-center justify-center gap-2 bg-white text-[#111] border border-black/25 hover:bg-gray-50 px-6 py-3 rounded font-medium transition mb-4 text-sm">Continue with Google</a>
        <div className="flex items-center gap-3 text-[#6b6b6b] text-xs mb-4"><span className="h-px flex-1 bg-black/5" />or use email<span className="h-px flex-1 bg-black/5" /></div>
        {error && <p role="alert" className="text-[#111] text-sm mb-4 text-center bg-[#f4f4f4] border border-black/40 rounded-lg px-3 py-2">{error}</p>}
        <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-[#333]">Your name
          <input name="name" type="text" required placeholder="Your name" autoComplete="name"
            className="field" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[#333]">Email
          <input name="email" type="email" required placeholder="you@company.com" autoComplete="email"
            className="field" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[#333]">Company (optional)
          <input name="business_name" type="text" placeholder="Company (optional)" autoComplete="organization"
            className="field" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[#333]">Password
          <input name="password" type="password" required placeholder="Password (10+ characters, letters and numbers)" minLength={10} autoComplete="new-password"
            className="field" />
          </label>
          <button type="submit" disabled={loading}
            className="btn-primary mt-1 !py-3">
            {loading ? 'Creating account…' : 'Create your account'}
          </button>
        </form>
        <p className="mt-4 text-sm text-[#666] text-center">
          Already have an account? <a href="/sign-in" className="inline-flex items-center justify-center min-h-11 min-w-11 text-[#111] underline underline-offset-2 hover:underline">Sign in</a>
        </p>
        <p className="mt-3 text-xs text-[#6b6b6b] text-center">
          <a href="/terms" className="underline underline-offset-2 hover:text-[#111]">Terms of Service</a> · <a href="/privacy" className="underline underline-offset-2 hover:text-[#111]">Privacy Policy</a>
        </p>
      </div>
    </main>
  )
}
