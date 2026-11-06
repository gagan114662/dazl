import { ImageResponse } from 'next/og'

// #534: the social card every public page inherits (root layout metadata).
export const alt = 'dazl - find leads with proof'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OgImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 80, background: '#fff', color: '#111', fontFamily: 'sans-serif' }}>
        <div style={{ fontSize: 104, fontWeight: 700, letterSpacing: '-0.04em' }}>dazl.</div>
        <div style={{ fontSize: 40, marginTop: 20, lineHeight: 1.3, color: '#444' }}>Say who you are looking for. dazl finds buyers showing intent and verifies each lead against its source.</div>
      </div>
    ),
    size,
  )
}
