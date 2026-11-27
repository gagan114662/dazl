"use client"
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { afterSignIn, keepInvite } from '@/lib/invite-return'
import { ClaimContextBanner, useClaimContext } from '../preview/claim/context-banner'
import { ResendConfirmationButton } from '../resend-confirmation'

// sentWithoutScript / errorWithoutScript (#1116): the outcome of a NATIVE post of this form (it was submitted before or
// without its script; the route redirected back with a code). Rendered on the server, so they show with no script.
// trialRule (#1704): the free-search rule line (lib/trial-copy.ts trialRuleLine), read by the page on the server; sign-in shows the same one.
export default function SignUpForm({ trialRule = '', sentWithoutScript = false, errorWithoutScript = '' }: { trialRule?: string; sentWithoutScript?: boolean; errorWithoutScript?: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(errorWithoutScript)
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
  if (sent || sentWithoutScript) {
    return (
      <main id="main" className="min-h-screen flex items-center justify-center glow px-4 py-10">
        <div className="card p-8 sm:p-10 w-full max-w-sm text-center" role="status">
          <Link href="/" className="text-xl font-medium tracking-tight block mb-6">dazl<span className="text-[#111]">.</span></Link>
          <h1 className="text-2xl font-medium mb-3">Check your email</h1>
          <p className="text-[#555] text-sm mb-4">If {sent ? <span className="text-[#111]">{sent}</span> : 'the address you entered'} can receive mail from us, a link to confirm it is on its way. Open it, then sign in. The link works once, for 24 hours.</p>
          <p className="text-[#555] text-sm mb-4">Nothing arrived? {sent ? 'Resend the email, or ' : ''}sign in with your password and we&apos;ll try to send a new link.</p>
          {sent ? <ResendConfirmationButton email={sent} /> : null}
          <a href="/sign-in" className="btn-primary inline-block !py-3 px-6">Sign in</a>
        </div>
      </main>
    )
  }

  return (
    <main id="main" className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-4 sm:p-8 w-full max-w-md">
        <Link href="/" className="text-xl font-medium tracking-tight block text-center mb-1.5 sm:mb-4">dazl<span className="text-[#111]">.</span></Link>
        <h1 className="text-2xl font-medium mb-1 text-center">Create your account</h1>
        <p className="text-[#555] text-sm mb-1 sm:mb-4 text-center">
          A search is one run that looks for businesses that need what you sell. {trialRule ? 'No card needed.' : 'Free searches are unavailable right now.'}
        </p>
        <ClaimContextBanner business={claim.business} action="Create your account" />
        <a href={claim.googleHref} data-testid="google-primary" className="btn-primary !py-3 w-full flex items-center justify-center gap-2 text-sm">Continue with Google</a>
        {/* Said only where a free first search can really run (#1428: the rule is empty otherwise); the spacing stays the same either way. */}
        <p className="text-xs text-[#555] text-center mt-1 sm:mt-2 mb-2 sm:mb-3" data-testid="trial-rule">{trialRule}</p>
        <div className="flex items-center gap-3 text-[#6b6b6b] text-xs mb-1 sm:mb-3"><span className="h-px flex-1 bg-black/5" />or use email<span className="h-px flex-1 bg-black/5" /></div>
        {error && <p role="alert" className="text-[#111] text-sm mb-4 text-center bg-[#f4f4f4] border border-black/40 rounded-lg px-3 py-2">{error}</p>}
        {/* action (#1116): before or without the script, the browser posts the form to the same route the script calls, which
            answers a native post with a redirect back here (?sent=1 / ?error=code). It used to post to this page and reload silently. */}
        <form method="post" action="/api/auth/signup" onSubmit={handleSubmit} className="flex flex-col gap-1.5 sm:gap-2.5" data-testid="sign-up-form">
          {/* #1782: the short fields pair up on wider screens (name + company, email + password) and stack on
              phones, where a paired column is ~153px and too cramped; the password rules line stays under the
              password field. Phone spacing is tighter so the stacked card still fits the viewport. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-2.5">
            <label className="flex flex-col gap-1 text-sm text-[#333]">Your name
            <input name="name" type="text" required placeholder="Your name" autoComplete="name"
              className="field" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-[#333]">Company (optional)
            <input name="business_name" type="text" placeholder="Company (optional)" autoComplete="organization"
              className="field" />
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-2.5">
            <label className="flex flex-col gap-1 text-sm text-[#333]">Email
            <input name="email" type="email" required placeholder="you@company.com" autoComplete="email"
              className="field" />
            </label>
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-sm text-[#333]">Password
                <input name="password" type="password" required minLength={10} autoComplete="new-password"
                  aria-describedby="signup-password-rules" className="field" />
              </label>
              <p id="signup-password-rules" className="text-xs text-[#555]">Use at least 10 characters, including a letter and a number.</p>
            </div>
          </div>
          <button type="submit" disabled={loading}
            className="flex items-center justify-center gap-2 bg-white text-[#111] border border-black/25 hover:bg-gray-50 px-6 py-2.5 sm:py-3 min-h-11 rounded font-medium transition text-sm disabled:opacity-50">
            {loading ? 'Creating account…' : 'Create your account'}
          </button>
        </form>
        <p className="mt-2 sm:mt-3 text-sm text-[#666] text-center">
          Already have an account? <a href="/sign-in" className="text-[#111] underline underline-offset-2 hover:underline">Sign in</a>
        </p>
        <p className="mt-1 sm:mt-2 text-xs text-[#6b6b6b] text-center">
          By creating an account you agree to the <a href="/terms" className="underline underline-offset-2 hover:text-[#111]">Terms</a> and <a href="/privacy" className="underline underline-offset-2 hover:text-[#111]">Privacy Policy</a>.
        </p>
      </div>
    </main>
  )
}

// What a return to /sign-in says: a Google sign-in outcome (?error=) or a finished password reset (?reset=1, which wins).
const SIGN_IN_ERRORS: Record<string, string> = {
  google_failed: 'Google sign-in did not work. Try again.', google_unavailable: 'Google sign-in is not available right now.',
  google_email_unverified: 'Your Google email is not verified, so we cannot use it.',
  google_email_exists: 'An account with this email already exists. Sign in with your password.', too_many: 'Too many attempts. Try again later.', unavailable: 'Sign-in is briefly unavailable. Try again in a moment.',
}
function signInNotice(search: string): string {
  const q = new URLSearchParams(search)
  if (q.get('reset') === '1') return 'Your password is changed and every device was signed out. Sign in with the new password.'
  const e = q.get('error')
  return e && Object.hasOwn(SIGN_IN_ERRORS, e) ? SIGN_IN_ERRORS[e] : ''
}
const noSubscribe = () => () => {}

// The sign-in form. trialRule (#1704): the free-search rule line, read by app/sign-in/page.tsx at request time. The page's
// own address is read as an external store (empty on the server) so the return notice needs no state set in an effect.
export function SignInForm({ trialRule = '' }: { trialRule?: ReactNode }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const search = useSyncExternalStore(noSubscribe, () => window.location.search, () => '')
  // null until the form is submitted: until then the address's notice shows; a submit replaces it, as before
  const [submitError, setError] = useState<string | null>(null)
  const error = submitError ?? signInNotice(search)
  const claim = useClaimContext()
  useEffect(() => { keepInvite() }, [])

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
        <p className="text-xs text-[#555] text-center mt-2 mb-4" data-testid="trial-rule">{trialRule}</p>
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
