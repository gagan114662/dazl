'use client'
import { keepClaim } from '@/lib/invite-return'

// Claim actions on the public preview page (#416). The password paths carry the token in this tab's session
// storage (never a URL a redirect could leak) AND go through the validating start route, which keeps a short httpOnly
// intent cookie: the email confirmation link usually opens in a new tab, where the tab's copy is gone. The Google path
// goes through its own validating start route.
export default function PreviewCta({ token, business }: { token: string; business: string }) {
  const go = (href: string) => () => { keepClaim(token, business); window.location.href = href }
  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
      <a href={`/api/preview/${token}/google`} style={{ padding: '10px 16px', background: '#111', color: '#fff', borderRadius: 8, textDecoration: 'none' }}>Claim with Google</a>
      <button onClick={go(`/api/preview/${token}/continue?to=sign-up`)} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #999', background: '#fff', cursor: 'pointer' }}>Create account</button>
      <button onClick={go(`/api/preview/${token}/continue?to=sign-in`)} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #999', background: '#fff', cursor: 'pointer' }}>Sign in</button>
    </div>
  )
}
