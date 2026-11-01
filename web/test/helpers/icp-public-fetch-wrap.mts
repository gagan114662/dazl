// Test-only wrapper: the real fetchPublicHtml (SSRF guard, DNS validation, redirect re-validation, size caps) with
// the raw pinned-socket hop handed to the process-global fetch stub the runtime installs. Real DNS validation
// still runs first, so not_public/invalid refusals are exercised; only the socket is fixture-bound.
export * from '../../lib/net/public-fetch.ts'
import { fetchPublicHtml as realFetchPublicHtml, type PublicFetchDeps } from '../../lib/net/public-fetch.ts'
export function fetchPublicHtml(url: string, deps: PublicFetchDeps = {}) {
  const viaStub = ((u: unknown, init?: unknown) => (globalThis.fetch as (a: unknown, b?: unknown) => Promise<Response>)(u, init)) as unknown as typeof fetch
  return realFetchPublicHtml(url, { ...deps, fetchImpl: viaStub })
}
