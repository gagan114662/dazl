// #1255: React #418 on a build run with a different DAZL_ENV than it was built with. With cacheComponents the root
// layout is in the prerendered shell (built HTML), but a runtime isStaging() read put the banner into the RSC payload
// only, so server HTML and client tree disagreed. The banner must follow the build-time flag, the same value in both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stagingBannerOn } from '../lib/staging.ts'

test('banner follows the build-inlined flag, not the runtime DAZL_ENV', () => {
  assert.equal(stagingBannerOn({ NEXT_PUBLIC_DAZL_STAGING: '1' }), true)
  assert.equal(stagingBannerOn({ NEXT_PUBLIC_DAZL_STAGING: '' , DAZL_ENV: 'staging' }), false)
  assert.equal(stagingBannerOn({}), false)
})

test('next.config inlines the staging flag at build and the layout renders the banner from it', () => {
  const cfg = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8')
  assert.match(cfg, /NEXT_PUBLIC_DAZL_STAGING:\s*process\.env\.DAZL_ENV === 'staging' \? '1' : ''/)
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /stagingBannerOn\(\) && <div role="note" data-testid="staging-banner"/)
  assert.doesNotMatch(layout, /isStaging\(\) && <div/)
})
