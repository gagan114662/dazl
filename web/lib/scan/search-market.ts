import { placeIn, WORLD_CITIES } from '../sources/jobboards.ts'
import { countriesIn, countryOfRegion, regionsIn } from './countries.ts'
import { isoCountry } from './icp.ts'

export interface SearchMarket {
  country: string | null
  language: string | null
}

export const MARKET_NOTICE = 'Searched without a market, so results lean US/English. Set your country in Settings.'

export function marketLanguage(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z]{2,3}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
}

export function browserMarket(locale: unknown): SearchMarket {
  if (typeof locale === 'string' && locale.length <= 80) {
    try {
      const parsed = new Intl.Locale(locale)
      return { country: isoCountry(parsed.region), language: marketLanguage(parsed.language) }
    } catch { /* browser provided no usable locale */ }
  }
  return { country: null, language: null }
}

export function resolveSearchMarket(query: string, profile?: Partial<SearchMarket> | null, account?: Partial<SearchMarket> | null): SearchMarket {
  const place = placeIn(query)?.name
  const countries = countriesIn(query)
  const cityCountry = place && WORLD_CITIES[place] ? countriesIn(WORLD_CITIES[place]) : []
  const regions = place ? regionsIn(place).map(countryOfRegion) : []
  const queryCountries = [...new Set(countries.length ? countries : regions.length ? regions : cityCountry)]
  const profileCountry = isoCountry(profile?.country)
  const accountCountry = isoCountry(account?.country)
  const country = queryCountries.length === 1 ? queryCountries[0] : profileCountry ?? accountCountry
  const profileLanguage = !profileCountry || profileCountry === country ? marketLanguage(profile?.language) : null
  const accountLanguage = !accountCountry || accountCountry === country ? marketLanguage(account?.language) : null
  return { country, language: profileLanguage ?? accountLanguage }
}

// TinyFish derives a country from language alone. Send neither hint when there is no country.
export function tinyfishMarket(market: SearchMarket): { location?: string; language?: string } {
  return market.country ? { location: market.country, ...(market.language ? { language: market.language } : {}) } : {}
}
