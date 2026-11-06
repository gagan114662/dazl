'use client'
import { useSyncExternalStore } from 'react'
import { claimIntent, googleStartHref } from '@/lib/invite-return'

// Sign-in/sign-up while carrying a preview claim (#416): say which proof the prospect is continuing, and keep the claim
// on whichever auth path they pick. Reads only this tab's own intent; nothing is fetched or written here. The server
// render (no sessionStorage) shows no banner and the plain Google start; the browser then reads the tab's intent.
const noSubscribe = () => () => {}
export function useClaimContext(): { business: string | null; googleHref: string } {
  const business = useSyncExternalStore(noSubscribe, () => claimIntent()?.business ?? null, () => null)
  const googleHref = useSyncExternalStore(noSubscribe, googleStartHref, () => '/api/auth/google')
  return { business, googleHref }
}

export function ClaimContextBanner({ business, action }: { business: string | null; action: string }) {
  if (business === null) return null
  return (
    <p data-testid="claim-context" className="text-[#111] text-sm mb-4 text-center bg-[#f4f4f4] border border-black/15 rounded-lg px-3 py-2">
      {business ? <>You are continuing the proof preview prepared for <strong>{business}</strong>.</> : <>You are continuing your proof preview.</>}
      {' '}{action} to review the companies and offer it found, then claim it.
    </p>
  )
}
