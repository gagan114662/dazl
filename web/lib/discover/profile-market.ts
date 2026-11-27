import { isoCountry } from '../scan/icp.ts'

type ProfileMarket = { country?: string | null; language?: string | null; where?: readonly string[] }

export function marketLanguage(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z]{2,3}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
}

export function profileMarket(profile?: ProfileMarket | null) {
  return { country: isoCountry(profile?.country), language: marketLanguage(profile?.language) }
}

// Direct callers without a resolved market retain the existing profile-only fallback.
export function profileMarketLines(profile?: ProfileMarket | null): string[] {
  if (profile?.where?.some(place => place.trim())) return []
  const { country, language } = profileMarket(profile)
  return [
    country ? `Saved country (only if the request names no place): ${country}` : '',
    language ? `Saved source language (only if the request leaves the language open): ${language}` : '',
  ].filter(Boolean)
}
