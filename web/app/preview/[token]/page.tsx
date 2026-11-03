import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { getDb } from '@/lib/db/client'
import { getMasterKey } from '@/lib/secrets'
import { isClaimToken, readPublicClaim, type ClaimSnapshot } from '@/lib/scan/preview-claim'
import PreviewCta from './cta'

// The public proof page a prospect's link opens (#416). It serves only the stored stripped artifact of its own run:
// no contacts, no spend, no seller tenant data. Claimed and expired claims are terminal and show no content.
type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ e?: string }> }
// cacheComponents: the dynamic work must sit behind a Suspense boundary, so the default export stays synchronous
// and hands the params/searchParams promises to the async inner (the app/reset pattern).
export default function PreviewPage(props: Props) {
  return <Suspense fallback={<main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px' }}>Loading preview...</main>}><PreviewBody {...props} /></Suspense>
}
async function PreviewBody({ params, searchParams }: Props) {
  await connection() // request-time rendering, inside the Suspense boundary
  const { token } = await params
  const { e } = await searchParams
  if (!isClaimToken(token)) notFound()
  const c = await readPublicClaim(await getDb(), getMasterKey(), token)
  if (c.status === 'unknown') notFound()
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px', fontFamily: 'system-ui, sans-serif', color: '#1a1a1a' }}>
      {c.status === 'expired' && <>
        <h1 style={{ fontSize: 24 }}>This preview has expired</h1>
        <p>Proof previews are only shown while their evidence is current. Ask the person who sent it for a fresh one.</p>
      </>}
      {c.status === 'claimed' && <>
        <h1 style={{ fontSize: 24 }}>This preview has been claimed</h1>
        <p>It is now private to the account that claimed it. If that was you, sign in to see it.</p>
      </>}
      {c.status === 'ok' && <>
        <p style={{ color: '#666', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }}>The sender prepared this preview for {c.business}</p>
        <h1 style={{ fontSize: 24 }}>Companies that look like your next customers</h1>
        <p><em>Inferred offer:</em> {c.snapshot.offer.text} (<a href={c.snapshot.offer.sourceUrl}>source</a>)</p>
        <ul style={{ paddingLeft: 18 }}>
          {c.snapshot.companies.map((co) => (
            <li key={co.company} style={{ marginBottom: 16 }}>
              <strong>{co.company}</strong> - {co.event} ({co.eventDate})<br />
              <span style={{ color: '#444' }}>"{co.quote}"</span> <a href={co.sourceUrl}>source</a>
            </li>
          ))}
        </ul>
        <p style={{ color: '#666', fontSize: 13 }}>{c.snapshot.disclaimer}</p>
        {e === 'foreign' && <p role="alert">That account does not match the recipient this preview was made for. Sign in with the account it was sent to.</p>}
        {e === 'unverified' && <p role="alert">Verify your email address, then open this link again to claim the preview.</p>}
        {(e === 'unknown' || e === 'expired') && <p role="alert">This preview is no longer available.</p>}
        {e === 'too_many' && <p role="alert">Too many attempts. Try again in a few minutes.</p>}
        <PreviewCta token={token} business={c.business} />
      </>}
    </main>
  )
}
