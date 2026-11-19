#!/usr/bin/env node
// Print the current base parent of the checked-out GitHub PR merge commit. The event's base
// can lag this parent; diffing that old SHA against the merge wrongly includes main-only work.
import { execFileSync } from 'node:child_process'

const [merge, prHead, eventBase] = process.argv.slice(2)
const sha = v => /^[0-9a-f]{40}$/.test(v ?? '')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
try {
  if (![merge, prHead, eventBase].every(sha)) throw new Error('expected full merge, PR head, and event base SHAs')
  if (git('rev-parse', 'HEAD') !== merge) throw new Error('checkout is not the event merge commit')
  const [commit, base, head, ...extra] = git('rev-list', '--parents', '-n', '1', merge).split(' ')
  if (commit !== merge || !sha(base) || head !== prHead || extra.length || base === head) {
    throw new Error('commit is not a two-parent merge of the event PR head into its base')
  }
  // An older snapshot of this base is expected. A different history is not safe to narrow.
  try { git('merge-base', '--is-ancestor', eventBase, base) }
  catch { throw new Error('event base is not an ancestor of the merge base parent') }
  console.log(base)
} catch (e) {
  console.error(`Cannot verify PR merge scope: ${e.message}`)
  process.exitCode = 1
}
