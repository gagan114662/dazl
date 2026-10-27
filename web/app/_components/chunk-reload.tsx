'use client'
import { useEffect } from 'react'
import { isChunkLoadError } from '@/lib/chunk-error'

// A tab opened before a deploy can ask for JavaScript chunks the new build no longer serves. Next then throws
// ChunkLoadError and the page stays broken until a manual refresh. Reload once per page to fetch the current build;
// the sessionStorage guard stops a reload loop if the chunk is genuinely missing.
export default function ChunkReload() {
  useEffect(() => {
    const key = `dazl-chunk-reload:${location.pathname}`
    const recover = (reason: unknown) => {
      if (!isChunkLoadError(reason)) return
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, String(Date.now())) } catch { return }
      location.reload()
    }
    const onError = (e: ErrorEvent) => recover(e.error ?? e.message)
    const onRejection = (e: PromiseRejectionEvent) => recover(e.reason)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    // A page that loaded cleanly clears its guard, so a later deploy can recover the same way.
    const clear = setTimeout(() => { try { sessionStorage.removeItem(key) } catch { /* storage unavailable */ } }, 10_000)
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); clearTimeout(clear) }
  }, [])
  return null
}
