"use client"
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { afterSignIn, keepInvite } from '@/lib/invite-return'

export default function SignUp() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
    router.push(afterSignIn())
  }

  return (
    <main className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm">
        <a href="/" className="text-xl font-medium tracking-tight block text-center mb-6">dazl<span className="text-[#111]">.</span></a>
        <h1 className="text-2xl font-medium mb-1 text-center">Create your account</h1>
        <p className="text-[#555] text-sm mb-6 text-center">Free plan: 50 scans a month with your own AI key. New accounts may get 3 trial scans first. Upgrade any time.</p>
        <a href="/api/auth/google" className="flex items-center justify-center gap-2 bg-white text-[#111] border border-black/25 hover:bg-gray-50 px-6 py-3 rounded font-medium transition mb-4 text-sm">Continue with Google</a>
        <div className="flex items-center gap-3 text-[#6b6b6b] text-xs mb-4"><span className="h-px flex-1 bg-black/5" />or use email<span className="h-px flex-1 bg-black/5" /></div>
        {error && <p role="alert" className="text-[#111] text-sm mb-4 text-center bg-[#f4f4f4] border border-black/40 rounded-lg px-3 py-2">{error}</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input name="name" type="text" required placeholder="Your name"
            className="field" />
          <input name="email" type="email" required placeholder="you@company.com"
            className="field" />
          <input name="business_name" type="text" placeholder="Company (optional)"
            className="field" />
          <input name="password" type="password" required placeholder="Password (10+ characters, letters and numbers)" minLength={10}
            className="field" />
          <button type="submit" disabled={loading}
            className="btn-primary mt-1 !py-3">
            {loading ? 'Creating account…' : 'Create your account'}
          </button>
        </form>
        <p className="mt-4 text-sm text-[#666] text-center">
          Already have an account? <a href="/sign-in" className="text-[#111] underline underline-offset-2 hover:underline">Sign in</a>
        </p>
      </div>
    </main>
  )
}
