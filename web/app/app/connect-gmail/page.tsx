import Link from 'next/link'
import { connection } from 'next/server'
import { GMAIL_CONNECT_START, GOOGLE_PERMISSIONS_URL, gmailExplainer } from '@/lib/auth-google-explainer'

export const metadata = { title: 'Connect Gmail' }

// #1603: shown before Google's own screens, so the "Google hasn't verified this app" warning is not a surprise.
export default async function ConnectGmailPage() {
  await connection()
  const x = gmailExplainer()
  return (
    <div className="p-4 sm:p-8 max-w-xl text-sm" data-testid="gmail-explainer">
      <h1 className="text-2xl font-semibold tracking-tight mb-4">{x.title}</h1>
      {x.warning && (
        <div className="card p-5 mb-4" data-testid="gmail-explainer-warning">
          <p className="mb-3">{x.warning.lead}</p>
          <ol className="list-decimal pl-5 space-y-1 text-[#333]">{x.warning.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
      )}
      <div className="card p-5 mb-5">
        <ul className="list-disc pl-5 space-y-1 text-[#333]">{x.asks.map((s, i) => <li key={i}>{s}</li>)}</ul>
        <a className="underline underline-offset-2 inline-flex items-center min-h-[44px]" href={GOOGLE_PERMISSIONS_URL} target="_blank" rel="noreferrer">Open Google account permissions</a>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <a className="btn-primary inline-block" href={GMAIL_CONNECT_START} data-testid="gmail-explainer-continue">{x.cta}</a>
        <Link className="btn-ghost inline-block" href="/app/settings#gmail">{x.back}</Link>
      </div>
    </div>
  )
}
