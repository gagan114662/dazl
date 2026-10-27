'use client'
import { isChunkLoadError } from '@/lib/chunk-recovery'

// Any /app page that fails while rendering shows this inside the app layout (the nav stays) instead of a blank page.
// A missing JavaScript chunk (usually a tab from before a deploy) can only be fixed by loading the current version, so
// it offers Reload; anything else offers Try again first. Nothing here reloads on its own: the bounded automatic
// reload lives in lib/chunk-recovery.ts. Neither button resubmits a send, scan or draft.
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const chunk = isChunkLoadError(error)
  return (
    <div className="p-8 max-w-xl" role="alert">
      <h1 className="text-xl font-semibold mb-2">{chunk ? 'dazl was updated' : 'This page could not load'}</h1>
      <p className="text-sm text-[#555] mb-4">{chunk
        ? 'Part of this page is from an older version and could not load. Reload to get the current version. Nothing you approved or sent is affected.'
        : 'Something went wrong while showing this page. Nothing was sent or changed. Try again, or reload the page.'}</p>
      <div className="flex gap-2">
        <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={() => location.reload()}>Reload</button>
        {!chunk && <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={() => retry()}>Try again</button>}
      </div>
    </div>
  )
}
