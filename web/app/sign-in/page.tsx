"use client"
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { afterSignIn, keepInvite } from '@/lib/invite-return'
import { ClaimContextBanner, useClaimContext } from '../preview/claim/context-banner'

export default function SignIn() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const claim = useClaimContext()
  useEffect(() => {
    keepInvite()
    const e = new URLSearchParams(window.location.search).get('error')
    const m: Record<string, string> = {
      google_failed: 'Google sign-in did not work. Try again.', google_unavailable: 'Google sign-in is not available right now.',
      google_email_unverified: 'Your Google email is not verified, so we cannot use it.',
      google_email_exists: 'An account with this email already exists. Sign in with your password.', too_many: 'Too many attempts. Try again later.', unavailable: 'Sign-in is briefly unavailable. Try again in a moment.',
    }
    if (e && m[e]) setError(m[e])
    if (new URLSearchParams(window.location.search).get('reset') === '1') setError('Your password is changed and every device was signed out. Sign in with the new password.')
  }, [])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true); setError('')
    const fd = new FormData(e.currentTarget)
    const res = await fetch('/api/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') })
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error || 'Sign in failed'); setLoading(false); return }
    router.push(afterSignIn(data.resume))
  }

  return (
    <main id="main" className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm">
        <Link href="/" className="text-xl font-medium tracking-tight flex items-center justify-center min-h-11 mb-4">dazl<span className="text-[#111]">.</span></Link>
        <h1 className="text-2xl font-medium mb-1 text-center">Sign in</h1>
        <p className="text-[#555] text-sm mb-6 text-center">Enter your email to continue</p>
        <ClaimContextBanner business={claim.business} action="Sign in" />
        <a href={claim.googleHref} data-testid="google-primary" className="btn-primary !py-3 w-full flex items-center justify-center gap-2 text-sm">Continue with Google</a>
        <p className="text-xs text-[#555] text-center mt-2 mb-4">Free scans need Google sign-in.</p>
        <div className="flex items-center gap-3 text-[#6b6b6b] text-xs mb-4"><span className="h-px flex-1 bg-black/5" />or use email<span className="h-px flex-1 bg-black/5" /></div>
        {error && <p role="alert" className="text-[#111] text-sm mb-4 text-center bg-[#f4f4f4] border border-black/40 rounded-lg px-3 py-2">{error}</p>}
        <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-[#333]">Email
            <input name="email" type="email" required placeholder="you@company.com" autoComplete="email"
              className="field" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[#333]">Password
            <input name="password" type="password" required placeholder="Password" autoComplete="current-password"
              className="field" />
          </label>
          <button type="submit" disabled={loading}
            className="flex items-center justify-center gap-2 bg-white text-[#111] border border-black/25 hover:bg-gray-50 px-6 py-3 rounded font-medium transition text-sm mt-1 disabled:opacity-50">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-3 text-sm text-center"><a href="/reset" className="inline-flex items-center min-h-11 text-[#666] underline underline-offset-2">Forgot password?</a></p>
        <p className="mt-2 text-sm text-[#666] text-center">
          No account? <a href="/sign-up" className="inline-flex items-center min-h-11 text-[#111] underline underline-offset-2 hover:underline">Create an account</a>
        </p>
      </div>
    </main>
  )
}
