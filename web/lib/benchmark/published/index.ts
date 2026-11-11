// The published artifacts. latest.json is rewritten only by scripts/publish-scorecard.mts (live or recorded batches only); example-synthetic.json is invented data.
import latest from './latest.json' with { type: 'json' }
import example from './example-synthetic.json' with { type: 'json' }
import type { Published } from '../published.ts'
export const LATEST = latest as unknown as Published
export const EXAMPLE = example as unknown as Published
