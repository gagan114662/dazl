// A link published by a verified company for this person, not data from LinkedIn.
// The enrichment's source_url remains the first-party page (including currency checks).
const PREFIX = 'sitecrawl-profile-v1: '
const PROFILE = /^https:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/
export function listedProfileUrl(raw: string): string | null {
  // No query, fragment, encoded characters, userinfo, port, or lookalike host.
  return PROFILE.test(raw) ? raw : null
}
export function listedProfileLabel(profile: string): string | null {
  const url = listedProfileUrl(profile)
  return url ? PREFIX + url : null
}
export function profileFromListedLabel(label: string | null): string | null {
  return label?.startsWith(PREFIX) ? listedProfileUrl(label.slice(PREFIX.length)) : null
}
