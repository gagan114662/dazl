import { marketLanguage, profileMarket } from '../discover/profile-market.ts'
import { placeIn } from '../sources/jobboards.ts'
import { countriesIn, countryOfRegion, regionsIn, resolveSegment } from './countries.ts'
import { isoCountry } from './icp.ts'

export interface SearchMarket {
  country: string | null
  language: string | null
}

export const MARKET_NOTICE = 'Searched without a market, so results lean US/English. Set your country in Settings.'

export { marketLanguage }

export function browserMarket(locale: unknown): SearchMarket {
  if (typeof locale === 'string' && locale.length <= 80) {
    try {
      const parsed = new Intl.Locale(locale)
      return { country: isoCountry(parsed.region), language: marketLanguage(parsed.language) }
    } catch { /* browser provided no usable locale */ }
  }
  return { country: null, language: null }
}

function countriesForPlace(query: string): string[] {
  const place = placeIn(query)
  const countries = countriesIn(query)
  if (countries.length > 1) return countries
  if (place?.country && !resolveSegment(place.name, true)) return [place.country]
  const regions = place ? regionsIn(place.name).map(countryOfRegion) : []
  return countries.length ? countries : regions
}

export function resolveSearchMarket(query: string, profile?: Partial<SearchMarket> | null, account?: Partial<SearchMarket> | null): SearchMarket {
  // Keep comma-qualified cities together. A conjunction only separates places if both sides resolve.
  const coordinated = query.split(/\s+\b(?:and|or)\b\s+/i).map((part, i) => countriesForPlace(i ? `near ${part}` : part))
  const namedPlaces = coordinated.filter(countries => countries.length > 0)
  const queryCountries = [...new Set(namedPlaces.length > 1 ? namedPlaces.flat() : countriesForPlace(query))]
  if (queryCountries.length > 1) return { country: null, language: null }
  const savedProfile = profileMarket(profile)
  const profileCountry = savedProfile.country
  const accountCountry = isoCountry(account?.country)
  const country = queryCountries.length === 1 ? queryCountries[0] : profileCountry ?? accountCountry
  const profileLanguage = !profileCountry || profileCountry === country ? savedProfile.language : null
  const accountLanguage = !accountCountry || accountCountry === country ? marketLanguage(account?.language) : null
  return { country, language: profileLanguage ?? accountLanguage }
}

// TinyFish derives a country from language alone. Send neither hint when there is no country.
export function tinyfishMarket(market: SearchMarket): { location?: string; language?: string } {
  return market.country ? { location: market.country, ...(market.language ? { language: market.language } : {}) } : {}
}
