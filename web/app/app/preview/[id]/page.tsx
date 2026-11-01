import { notFound, redirect } from 'next/navigation'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { readClaimedPreview } from '@/lib/scan/preview-claim'

export const dynamic = 'force-dynamic'

// The stable private home of a claimed preview (#416): only the workspace that claimed it can read it; any other
// workspace's id reads as not found. Reading never consumes or mutates. Expiry is consistent with the public page:
// past the evidence expiry the preview is gone here too.
export default async function ClaimedPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) redirect('/sign-in')
  const { id } = await params
  const c = await readClaimedPreview(await getDb(), user.tenantId, id)
  if (!c) notFound()
  if ('expired' in c) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px' }}>
        <h1 style={{ fontSize: 24 }}>This preview has expired</h1>
        <p>Proof previews are only shown while their evidence is current.</p>
      </main>
    )
  }
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px' }}>
      <p style={{ color: '#666', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }}>Claimed preview for {c.business}</p>
      <h1 style={{ fontSize: 24 }}>Your proof preview</h1>
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
    </main>
  )
}
