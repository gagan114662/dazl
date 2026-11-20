// #1436 follow-up: set one workspace's daily AI spend cap (its entry in DAZL_RUN_MAX_USD_USERS, read by
// lib/llm/spend-pool.ts windowCap) in an env file, without touching any other entry or setting. Pure: the operator
// script (scripts/set-day-cap.mts) reads and writes the file. The per-scan cap (DAZL_SCAN_CAP_CAD, CAD 5) is separate and
// unchanged: a day cap only bounds how many scans fit in a day.
import { CAP_ENV, OWNER_DAY_CEILING_USD } from '../llm/spend-pool.ts'

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
