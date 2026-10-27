// True for the errors a browser raises when a JavaScript or CSS chunk from an older build cannot be loaded.
export function isChunkLoadError(reason: unknown): boolean {
  const e = reason as { name?: string; message?: string } | null | undefined
  const text = `${e?.name ?? ''} ${e?.message ?? (typeof reason === 'string' ? reason : '')}`
  return /ChunkLoadError|Loading chunk [^ ]+ failed|Failed to load chunk|Loading CSS chunk/i.test(text)
}
