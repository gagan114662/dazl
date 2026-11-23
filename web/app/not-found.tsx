import type { Metadata } from 'next'
import Link from 'next/link'

// #1642: an unknown address showed the framework's unbranded "This page could not be found". Same card as sign-in and
// reset, with the way home. The response status stays 404 (Next sets it for this file).
export const metadata: Metadata = { title: 'Page not found - dazl', robots: { index: false, follow: false } }

export default function NotFound() {
  return (
    <main id="main" className="min-h-screen flex items-center justify-center glow px-4 py-10">
      <div className="card p-8 sm:p-10 w-full max-w-sm text-center">
        <Link href="/" className="text-xl font-medium tracking-tight block mb-6">dazl<span className="text-[#111]">.</span></Link>
        <h1 className="text-2xl font-medium mb-2">Page not found</h1>
        <p className="text-[#555] text-sm mb-6">There is nothing at this address. The link may be old, or mistyped.</p>
        <Link href="/" className="btn-primary btn-plain !py-3 px-6">Back to dazl</Link>
        <p className="mt-4 text-sm text-[#666]"><a href="/sign-in" className="text-[#111] underline underline-offset-2">Sign in</a> · <a href="/contact" className="text-[#111] underline underline-offset-2">Contact</a></p>
      </div>
    </main>
  )
}
