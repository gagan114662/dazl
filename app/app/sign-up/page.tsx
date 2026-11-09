"use client"
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function SignUp() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
    router.push('/app')
  }

  return (
    <main style={{backgroundColor:'#030712',color:'#f9fafb',minHeight:'100vh'}} className="flex items-center justify-center">
      <div className="bg-white/5 border border-white/10 rounded-2xl p-10 w-full max-w-sm">
        <a href="/" className="text-xl font-bold tracking-tight block text-center mb-6">dazl<span className="text-indigo-400">.</span></a>
        <h1 className="text-2xl font-bold mb-1 text-center">Start free trial</h1>
        <p className="text-gray-400 text-sm mb-6 text-center">14 days free · CA$99/mo after · Cancel anytime</p>
        {error && <p className="text-red-400 text-sm mb-4 text-center">{error}</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input name="name" type="text" required placeholder="Your name"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <input name="email" type="email" required placeholder="you@company.com"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <input name="business_name" type="text" required placeholder="Business name (any country, any industry)"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <input name="password" type="password" required placeholder="Password (min 8 chars)" minLength={8}
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <button type="submit" disabled={loading}
            className="bg-indigo-500 hover:bg-indigo-400 disabled:opacity-60 px-6 py-3 rounded-xl font-semibold transition mt-1">
            {loading ? 'Creating account…' : 'Start free trial'}
          </button>
        </form>
        <p className="mt-4 text-sm text-gray-500 text-center">
          Already have an account? <a href="/sign-in" className="text-indigo-400 hover:underline">Sign in</a>
        </p>
      </div>
    </main>
  )
}
