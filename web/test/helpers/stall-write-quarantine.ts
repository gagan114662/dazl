import { clientFrames, type ClientFrame } from '../../lib/client-error-report.ts'

export interface SmokeWrite { method: string; url: string; body: string | null }
export interface SmokePageError { path: string; message: string; stack: string; loadedScripts: string[] }

// Factory removes this entry in the real hydration fix after #1752.
export const STALL_WRITE_QUARANTINE = [{
  path: '/app/settings', error: /^Minified React error #418;/,
  issue: 'https://github.com/gagan114662/dazl/issues/1755',
}] as const

function report(body: string | null): { path: string; frames: ClientFrame[] } | null {
  try {
    const value: unknown = JSON.parse(body ?? '')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join(',') !== 'frames,kind,path,type'
      || row.kind !== 'error' || row.type !== 'Error' || typeof row.path !== 'string'
      || !Array.isArray(row.frames) || !row.frames.length || row.frames.length > 8) return null
    const frames: ClientFrame[] = []
    for (const raw of row.frames) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const frame = raw as Record<string, unknown>
      if (Object.keys(frame).sort().join(',') !== 'col,file,line' || typeof frame.file !== 'string'
        || typeof frame.line !== 'number' || !Number.isSafeInteger(frame.line) || frame.line < 1
        || typeof frame.col !== 'number' || !Number.isSafeInteger(frame.col) || frame.col < 1) return null
      frames.push({ file: frame.file, line: frame.line, col: frame.col })
    }
    return { path: row.path, frames }
  } catch { return null }
}

// A report is exempt only when paired one-to-one with the exact observed error.
// The production report deliberately contains no message; matching its real stack
// frames prevents a different Settings error from borrowing a React418 exception.
export function unexpectedStallWrites(writes: SmokeWrite[], errors: SmokePageError[], origin: string): string[] {
  const remaining = [...errors]
  return writes.filter(write => {
    let url: URL
    try { url = new URL(write.url) } catch { return true }
    if (write.method !== 'POST' || url.origin !== origin || url.pathname !== '/api/client-errors' || url.search) return true
    const row = report(write.body)
    if (!row) return true
    for (const entry of STALL_WRITE_QUARANTINE) {
      if (row.path !== entry.path) continue
      const match = remaining.findIndex(error => error.path === entry.path && entry.error.test(error.message)
        && Array.isArray(error.loadedScripts) && error.loadedScripts.length > 0
        && JSON.stringify(clientFrames(error.stack, new Set(error.loadedScripts))) === JSON.stringify(row.frames))
      if (match < 0) continue
      remaining.splice(match, 1)
      return false
    }
    return true
  }).map(write => {
    try { return `${write.method} ${new URL(write.url).pathname}` } catch { return `${write.method} ${write.url}` }
  })
}
