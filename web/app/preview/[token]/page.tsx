import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { getMasterKey } from '@/lib/secrets'
import { isClaimToken, readPublicClaim, type ClaimSnapshot } from '@/lib/scan/preview-claim'
import PreviewCta from './cta'

export const dynamic = 'force-dynamic'

// The public proof page a prospect's link opens (#416). It serves only the stored stripped artifact of its own run:
// no contacts, no spend, no seller tenant data. Claimed and expired claims are terminal and show no content.
export default async function PreviewPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ e?: string }> }) {
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
        <p style={{ color: '#666', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }}>Preview for {c.business}</p>
        <h1 style={{ fontSize: 24 }}>Companies that look like your next customers</h1>
        <p><em>Inferred offer:</em> {c.snapshot.offer.text} (<a href={c.snapshot.offer.sourceUrl}>inferred from your public pages</a>)</p>
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
