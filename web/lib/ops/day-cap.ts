// #1436 follow-up: set one workspace's daily AI spend cap (its entry in DAZL_RUN_MAX_USD_USERS, read by
// lib/llm/spend-pool.ts windowCap) in an env file, without touching any other entry or setting. Pure: the operator
// script (scripts/set-day-cap.mts) reads and writes the file. The per-scan cap (DAZL_SCAN_CAP_CAD, CAD 5) is separate and
// unchanged: a day cap only bounds how many scans fit in a day.
import { closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CAP_ENV, OWNER_DAY_CEILING_USD } from '../llm/spend-pool.ts'

// A restart reloads only the live release's .release.env snapshot; the run env reaches it when the prod deploy
// regenerates that snapshot (ops/prod/deploy-prod.sh, ops/uptime/README.md), so the apply step is a deploy.
export const APPLY_STEP = 'apply it with the prod deploy, which regenerates the release env from this file: sudo /usr/local/lib/dazl-prod/deploy-prod.sh (see ops/uptime/README.md)'

// Replace the file whole or not at all: write a new file beside it (same dir, same mode and owner when permitted),
// flush it, then rename it over the original. A failure removes the temp file and leaves the original untouched.
export function writeEnvAtomically(file: string, text: string, beforeRename: () => void = () => {}, write: (fd: number, b: Buffer, off: number) => number = (fd, b, off) => writeSync(fd, b, off, b.length - off)): void {
  const st = statSync(file)
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', st.mode & 0o600)
  try {
    const buf = Buffer.from(text, 'utf8')
    // a write may take fewer bytes than asked: keep writing until every byte is in, then flush
    try {
      for (let off = 0; off < buf.length;) {
        const n = write(fd, buf, off)
        if (!(n > 0)) throw new Error('env write made no progress')
        off += n
      }
      try { fchownSync(fd, st.uid, st.gid) } catch { /* the operator may lack permission to restore ownership */ }
      const owner = fstatSync(fd)
      // Only restore group and other access once the original ownership is confirmed.
      if (owner.uid === st.uid && owner.gid === st.gid) fchmodSync(fd, st.mode & 0o777)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    beforeRename()
    renameSync(tmp, file)
  } catch (e) { try { unlinkSync(tmp) } catch { /* already gone */ } throw e }
}

const KEY = CAP_ENV.day.account
const TENANT = /^[A-Za-z0-9_-]{1,64}$/
const USD = /^\d{1,4}(?:\.\d{1,2})?$/

export function setDayCap(envText: string, tenantId: string, usd: string): { text: string; before: string | null; after: string } {
  if (!TENANT.test(tenantId)) throw new Error('invalid workspace id')
  if (!USD.test(usd) || !(Number(usd) > 0)) throw new Error('the cap must be a positive dollar amount, e.g. 5 or 5.00')
  if (Number(usd) > OWNER_DAY_CEILING_USD) throw new Error(`above the day ceiling (USD ${OWNER_DAY_CEILING_USD})`)
  const lines = envText.split('\n')
  const at = lines.findIndex(l => l.startsWith(`${KEY}=`))
  const current = at >= 0 ? lines[at].slice(KEY.length + 1).replace(/^['"]|['"]$/g, '') : ''
  const entries = current.split(',').map(x => x.trim()).filter(Boolean)
  const own = entries.filter(e => e.slice(0, e.lastIndexOf(':')).trim() === tenantId)
  const others = entries.filter(e => !own.includes(e))
  const line = `${KEY}=${[...others, `${tenantId}:${usd}`].join(',')}`
  if (at >= 0) lines[at] = line
  else { if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line); else lines.push(line) }
  return { text: lines.join('\n'), before: own.length ? own.join(',') : null, after: `${tenantId}:${usd}` }
}
