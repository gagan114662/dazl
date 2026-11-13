// #1127: a bound on concurrent ATS board API record reads (lib/scan/fetch-page.ts). One Ashby read is the whole board (up to
// ATS_RECORD_MAX_BYTES); the board memo shares a read of the SAME board, but the verifier fans out over its candidates, so
// distinct boards were read all at once. At most ATS_RECORD_CONCURRENCY reads run at a time per scan; the rest wait in order.
//
// Per scan: the slots belong to the scan attempt's own context (lib/scan/spend-cap.ts runWithScanSpend, opened once around
// the whole attempt), so one scan's queue never delays another scan. Work outside any scan (the owner's evidence recheck)
// shares one process-wide set of the same size.
//
// No deadlock, no leaked slot: a slot is held only for the duration of one read (no read takes a second slot), and it is
// released when that read settles, whether it answered, failed or timed out (each read is itself bounded by the request
// timeout, so a slot is always given back). A caller whose abort signal fires while it is still queued leaves the queue
// and never takes a slot.
import { scanSpendContext, type ScanSpendCtx } from './spend-cap.ts'

export const ATS_RECORD_CONCURRENCY = 2

interface Slots { active: number; queue: { start: () => void; signal?: AbortSignal; onAbort?: () => void }[] }
const perScan = new WeakMap<ScanSpendCtx, Slots>()
const outsideScan: Slots = { active: 0, queue: [] }
const slotsHere = (): Slots => {
  const ctx = scanSpendContext()
  if (!ctx) return outsideScan
  let s = perScan.get(ctx)
  if (!s) perScan.set(ctx, (s = { active: 0, queue: [] }))
  return s
}

function release(s: Slots): void {
  s.active--
  while (s.active < ATS_RECORD_CONCURRENCY && s.queue.length) {
    const next = s.queue.shift()!
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
    next.start()
  }
}

// Runs read() once a slot of the current scan is free; the slot is given back when the read settles.
export function withAtsReadSlot<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  const s = slotsHere()
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      s.active++
      let p: Promise<T>
      try { p = read() } catch (e) { p = Promise.reject(e) }
      p.then(v => { release(s); resolve(v) }, e => { release(s); reject(e) })
    }
    if (s.active < ATS_RECORD_CONCURRENCY) return start()
    const entry: Slots['queue'][number] = { start, signal }
    if (signal) {
      entry.onAbort = () => { const i = s.queue.indexOf(entry); if (i >= 0) s.queue.splice(i, 1); reject(new Error('aborted')) }
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    s.queue.push(entry)
  })
}

// For tests: the reads running and waiting outside any scan.
export const atsReadSlotsOutsideScan = () => ({ active: outsideScan.active, queued: outsideScan.queue.length })
