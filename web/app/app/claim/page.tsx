import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth-db'
import { getMasterKey } from '@/lib/secrets'
import { verifyClaim } from '@/lib/preview-claim'

// #416: a signed invitation link (lib/preview-claim.ts) opened after sign-in or sign-up. The /app gate already sent a
// signed-out visitor through sign-in and back here with the link intact. A valid link for this account opens the page it
// was made for; anything else says why and changes nothing (no workspace, profile or play is created or overwritten).
const WHY: Record<string, string> = {
  expired: 'This link has expired. Ask the person who sent it for a new one.',
  other_account: 'This link was made for a different email address. Sign in with the address it was sent to.',
  unavailable: "Invitation links can't be opened right now. Try again later.",
}

export default async function Claim({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const user = await getSessionUser((await cookies()).get('dazl_session')?.value)
  if (!user) redirect('/sign-in')
  const { t } = await searchParams
  let master: Buffer | null = null
  try { master = getMasterKey() } catch { /* not configured: no link can be checked */ }
  const r: ReturnType<typeof verifyClaim> | { ok: false; reason: 'unavailable' } = master ? verifyClaim(master, Array.isArray(t) ? t[0] : t, user) : { ok: false, reason: 'unavailable' }
  if (r.ok) redirect(r.path)
  return (
    <div className="max-w-lg mx-auto py-16 px-4">
      <div className="card p-6" data-testid="claim-refused" data-reason={r.reason}>
        <h1 className="text-lg font-medium mb-2">This link can&apos;t be opened</h1>
        <p className="text-sm text-[#555] mb-4">{WHY[r.reason] ?? 'This link is not valid. Ask the person who sent it for a new one.'}</p>
        <a className="btn-primary inline-block" href="/app">Go to your dashboard</a>
      </div>
    </div>
  )
}
