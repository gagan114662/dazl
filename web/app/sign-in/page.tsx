"use client"
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function SignIn() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get('error')
    const m: Record<string, string> = {
      google_failed: 'Google sign-in did not work. Try again.', google_unavailable: 'Google sign-in is not available right now.',
      google_email_unverified: 'Your Google email is not verified, so we cannot use it.',
      google_email_exists: 'An account with this email already exists. Sign in with your password.', too_many: 'Too many attempts. Try again later.',
    }
    if (e && m[e]) setError(m[e])
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
    router.push('/app')
  }

  return (
    <main className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm">
        <a href="/" className="text-xl font-medium tracking-tight block text-center mb-6">dazl<span className="text-indigo-400">.</span></a>
        <h1 className="text-2xl font-medium mb-1 text-center">Sign in</h1>
        <p className="text-gray-400 text-sm mb-6 text-center">Enter your email to continue</p>
        <a href="/api/auth/google" className="flex items-center justify-center gap-2 bg-white text-gray-900 hover:bg-gray-100 px-6 py-3 rounded-xl font-semibold transition mb-4 text-sm">Continue with Google</a>
        <div className="flex items-center gap-3 text-gray-600 text-xs mb-4"><span className="h-px flex-1 bg-white/10" />or use email<span className="h-px flex-1 bg-white/10" /></div>
        {error && <p role="alert" className="text-red-300 text-sm mb-4 text-center bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input name="email" type="email" required placeholder="you@company.com"
            className="field" />
          <input name="password" type="password" required placeholder="Password"
            className="field" />
          <button type="submit" disabled={loading}
            className="btn-primary mt-1 !py-3">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-sm text-gray-500 text-center">
          No account? <a href="/sign-up" className="text-indigo-400 hover:underline">Create an account</a>
        </p>
      </div>
    </main>
  )
}
