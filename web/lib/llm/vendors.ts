export type Vendor = 'anthropic' | 'openai'
export const VENDORS: Vendor[] = ['anthropic', 'openai']
export const isVendor = (v: unknown): v is Vendor => v === 'anthropic' || v === 'openai'

// Cheap shape check before we send the key anywhere.
const SHAPES: Record<Vendor, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,300}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,300}$/,
}
export const looksLikeKey = (vendor: Vendor, key: string) => SHAPES[vendor].test(key)

export type KeyCheck = 'valid' | 'invalid' | 'unavailable'

// Validates a key by listing models (no tokens spent). 401/403 => invalid;
// network errors, timeouts and 5xx/429 => unavailable (do not store, let the user retry).
// Not yet exercised against the live vendor APIs: only against a mocked fetch.
export async function validateKey(vendor: Vendor, key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  const req: { url: string; headers: Record<string, string> } =
    vendor === 'anthropic'
      ? { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }
      : { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }
  try {
    const res = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(10_000) })
    if (res.ok) return 'valid'
    return res.status === 401 || res.status === 403 ? 'invalid' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
