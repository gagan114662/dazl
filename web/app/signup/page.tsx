import { permanentRedirect } from 'next/navigation'
import { connection } from 'next/server'

type LegacySearchParams = Promise<Record<string, string | string[] | undefined>>

function withQuery(destination: string, params: Record<string, string | string[] | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) search.append(key, entry)
    } else if (value !== undefined) {
      search.append(key, value)
    }
  }
  const query = search.toString()
  return query ? `${destination}?${query}` : destination
}

// Legacy path: /signup now lives at /sign-up. Permanent redirect, query string preserved.
// #1929: await connection() before the redirect (same pattern as sign-up, review of #670): without a
// dynamic call, cacheComponents prerenders this route at build time and the permanentRedirect throw is
// captured and served as the __next_error__ shell with HTTP 200. The binding keeps it a per-request 308.
export const instant = false

export default async function LegacySignupRedirect({
  searchParams,
}: {
  searchParams: LegacySearchParams
}) {
  await connection()
  permanentRedirect(withQuery('/sign-up', await searchParams))
}
