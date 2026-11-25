import { permanentRedirect } from 'next/navigation'

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

// Legacy path: /signin now lives at /sign-in. Permanent redirect, query string preserved.
export default async function LegacySigninRedirect({
  searchParams,
}: {
  searchParams: LegacySearchParams
}) {
  permanentRedirect(withQuery('/sign-in', await searchParams))
}
