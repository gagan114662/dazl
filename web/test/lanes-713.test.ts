// #713: the replies lane is test-only until something produces into it. The guarantee customers get today is the tick
// design (reply sync runs inside the internal tick; scans run in the separate scan runner). This test keeps the code's
// claim honest: if a producer for a replies-lane kind appears, the testOnly marker must be removed in the same change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANES } from '../lib/queue/types.ts'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function replyLaneProducers(): string[] {
  const kinds = LANES.replies.kinds.map((k) => k.replace(/[-]/g, '\\-')).join('|')
  const re = new RegExp(`kind:\\s*['"\`](${kinds})['"\`]`)
  return [...sources(join(WEB, 'lib')), ...sources(join(WEB, 'app'))]
    .filter((p) => !p.includes(join('lib', 'queue')))
    .filter((p) => /\.enqueue\(/.test(readFileSync(p, 'utf8')) && re.test(readFileSync(p, 'utf8')))
}

test('#713: replies lane is marked test-only exactly while nothing in lib/ or app/ enqueues its kinds', () => {
  const producers = replyLaneProducers()
  const marked = (LANES.replies as { testOnly?: boolean }).testOnly === true
  assert.equal(marked, producers.length === 0, `testOnly=${marked} but producers: ${producers.join(', ') || 'none'}`)
})

test('#713: the internal tick runs reply sync itself, so replies never wait in the research queue', () => {
  const tick = readFileSync(join(WEB, 'app', 'api', 'internal', 'tick', 'route.ts'), 'utf8')
  assert.match(tick, /syncReplies|reply_sync|replySync/)
})
