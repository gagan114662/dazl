'use client'
import { useEffect } from 'react'
import { reportClientError } from '@/lib/client-error-report'
import { isChunkLoadError } from '@/lib/chunk-recovery'
import { BOUNDARY_COPY } from '@/lib/error-boundary-copy'

// Any /app page that fails while rendering shows this inside the app layout (the nav stays) instead of a blank page.
// The copy (lib/error-boundary-copy.ts) describes only the display failure: this boundary cannot tell whether an action
// just taken already succeeded. A missing JavaScript chunk can only be fixed by loading the current version, so it
// offers Reload; anything else also offers Try again (re-renders the page). Nothing here reloads on its own (the
// bounded automatic reload lives in lib/chunk-recovery.ts), and neither button submits anything.
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { reportClientError('boundary', error) }, [error])
  const copy = isChunkLoadError(error) ? BOUNDARY_COPY.chunk : BOUNDARY_COPY.other
  return (
    <div className="p-8 max-w-xl" role="alert">
      <h1 className="text-xl font-semibold mb-2">{copy.title}</h1>
      <p className="text-sm text-[#555] mb-4">{copy.body}</p>
      <div className="flex gap-2">
        <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={() => location.reload()}>Reload</button>
        {copy === BOUNDARY_COPY.other && <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={() => retry()}>Try again</button>}
      </div>
    </div>
  )
}
