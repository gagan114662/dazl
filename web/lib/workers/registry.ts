// The reviewed worker catalog this build ships (docs/design/runtime-workers.md). A worker can be registered at runtime
// only if it is listed here, i.e. its code went through review and merged, and the file on disk still hashes to the
// sha256 pinned below at review time. Modules are imported statically: nothing is loaded from a path a caller names.
//
// Changing a reviewed module changes its hash: re-pin it here (test/workers-catalog.test.ts fails until you do), and
// give the change a new version, since a registered (name, version) is immutable.
import { key, type Registry } from './definition.ts'
import * as textStats100 from './reviewed/text-stats.v1.0.0.ts'
import * as textStats110 from './reviewed/text-stats.v1.1.0.ts'

export const REVIEWED: Registry = new Map([
  [key('text-stats', '1.0.0'), { module: textStats100, file: new URL('./reviewed/text-stats.v1.0.0.ts', import.meta.url), sha256: '2fd13349240a50aaac74554af6771cbc90942ebeef978fcb78aec26cdb060eb9' }],
  [key('text-stats', '1.1.0'), { module: textStats110, file: new URL('./reviewed/text-stats.v1.1.0.ts', import.meta.url), sha256: 'e77c73823fd871ba2111a963f7ecb15bdf9fe6935d13b7d464752190ccddbd35' }],
])
