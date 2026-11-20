import { createElement } from 'react'

/** Optional evidence note, independent of adapters, city support, switches and scan eligibility. */
export function OptionalRegistryNote() {
  return createElement('p', {
    className:'text-xs text-[var(--ink-2)]',
    'data-testid':'optional-registry-note',
  }, 'Public permits and business licences are a bonus where available. They’re not required to run a search.')
}
