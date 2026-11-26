import { isoCountry, type Icp } from '../scan/icp.ts'

type ProfileMarket = Partial<Pick<Icp, 'where' | 'country' | 'language'>>

// A saved market fills omissions in the typed request when the profile has no named place.
export function profileMarketLines(profile?: ProfileMarket | null): string[] {
  if (!profile || profile.where?.some(place => place.trim())) return []

  const country = isoCountry(profile.country)
  const language = profile.language?.trim().toLowerCase()
  const lines: string[] = []
  if (country) lines.push(`Saved country (only if the request names no place): ${country}`)
  if (language && /^[a-z]{2}$/.test(language)) {
    lines.push(`Saved source language (only if the request leaves the language open): ${language}`)
  }
  return lines
}
