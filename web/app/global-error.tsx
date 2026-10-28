'use client'
import { useEffect } from 'react'
import { reportClientError } from '@/lib/client-error-report'
import { isChunkLoadError } from '@/lib/chunk-recovery'
import { BOUNDARY_COPY } from '@/lib/error-boundary-copy'

// Last resort when the root layout itself fails: it replaces the whole document, so it renders its own <html>/<body>
// with inline styles (globals.css may be the asset that failed). Same copy and buttons as app/error.tsx.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { reportClientError('boundary', error) }, [error])
  const copy = isChunkLoadError(error) ? BOUNDARY_COPY.chunk : BOUNDARY_COPY.other
  const btn = { background: '#111', color: '#fff', border: 0, padding: '8px 14px', font: 'inherit', cursor: 'pointer' } as const
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#fff', color: '#111', font: '14px/1.4 system-ui, sans-serif' }}>
        <main style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
          <div role="alert">
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>{copy.title}</h1>
            <p style={{ color: '#555', margin: '0 0 16px' }}>{copy.body}</p>
            <button type="button" style={btn} onClick={() => location.reload()}>Reload</button>
            {copy === BOUNDARY_COPY.other && <button type="button" style={{ ...btn, background: '#fff', color: '#111', border: '1px solid #111', marginLeft: 8 }} onClick={() => retry()}>Try again</button>}
          </div>
        </main>
      </body>
    </html>
  )
}
