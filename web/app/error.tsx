'use client'
import { isChunkLoadError } from '@/lib/chunk-recovery'
import { BOUNDARY_COPY } from '@/lib/error-boundary-copy'

// The same boundary as app/app/error.tsx for every page outside /app (home, sign-in, sign-up, privacy, terms): a page
// that fails while rendering - most often a missing JavaScript chunk after a deploy - shows this instead of a blank
// page. A missing chunk offers Reload only; anything else also offers Try again. Neither button submits anything, and
// the bounded automatic reload stays in lib/chunk-recovery.ts.
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  const copy = isChunkLoadError(error) ? BOUNDARY_COPY.chunk : BOUNDARY_COPY.other
  return (
    <main className="p-8 max-w-xl mx-auto">
      <div role="alert">
        <h1 className="text-xl font-semibold mb-2">{copy.title}</h1>
        <p className="text-sm text-[#555] mb-4">{copy.body}</p>
        <div className="flex gap-2">
          <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={() => location.reload()}>Reload</button>
          {copy === BOUNDARY_COPY.other && <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={() => retry()}>Try again</button>}
        </div>
      </div>
    </main>
  )
}
