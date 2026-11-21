import Link from 'next/link'

// #1428: one dazl logo on the homepage, the auth pages and the other public pages: the homepage nav's wordmark.
export default function Wordmark({ className = '' }: { className?: string }) {
  return <Link href="/" className={`text-[22px] font-semibold tracking-tight text-[var(--ink)] inline-flex items-center min-h-11 ${className}`} data-testid="wordmark">dazl</Link>
}
