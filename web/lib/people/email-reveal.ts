// #1036 (free email tier, Gagan 15 Nov: no paid email APIs, no SMTP mailbox check). An address the company prints on its own
// site is the best email dazl can offer, but many small-business sites hide it from scrapers in two common ways:
//  1. Cloudflare "Email Address Obfuscation": the page carries `<span class="__cf_email__" data-cfemail="HEX">[email protected]</span>`
//     and/or `<a href="/cdn-cgi/l/email-protection#HEX">`. A browser decodes HEX with a one-byte XOR key (the first byte); the
//     address is printed in plain sight for every visitor, so reading it is reading the published page, not guessing.
//  2. Bracketed text: "jane.doe [at] acme [dot] com", "jane(at)acme.com".
// revealEmails rewrites both IN PLACE into the plain address, so every reader downstream (role inboxes, the published personal tier,
// pattern learning, the address-context pairing) sees exactly what a visitor sees and keeps applying its own same-site/role/person rules.
// Nothing is invented: a HEX that does not decode to one well-formed address is left untouched. Bare " at " / " dot " words are NOT
// read ("meet us at acme.com" is a sentence, not an address); only the bracketed forms are.

const ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/i

// Cloudflare's scheme: hex pairs; the first pair is the key, every following byte XOR key is one character (UTF-8 bytes).
export function decodeCfEmail(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){3,300}$/i.test(hex)) return null
  const key = parseInt(hex.slice(0, 2), 16)
  const bytes: number[] = []
  for (let i = 2; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16) ^ key)
  let out: string
  try { out = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) } catch { return null }
  out = out.trim()
  // A protected href may carry "?subject=..." after the address; the address is what the visitor's mail app receives.
  const addr = out.split('?')[0]
  return ADDRESS.test(addr) ? addr.toLowerCase() : null
}

const CF_ELEMENT = /<([a-z][a-z0-9]*)\b[^>]*\bdata-cfemail\s*=\s*["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/\1\s*>/gi
const CF_HREF = /(["'])(?:https?:\/\/[^"'\s]*?)?\/cdn-cgi\/l\/email-protection#([0-9a-f]+)\1/gi
const BRACKETED = /\b([a-z0-9][a-z0-9._%+-]{0,63})\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\})\s*([a-z0-9][a-z0-9-]{0,62}(?:(?:\.|\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*)[a-z0-9-]{1,63})*?)(?:\.|\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*)([a-z]{2,24})\b(?![.-]?[a-z0-9])/gi
const DOT = /\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*/gi

export function revealEmails(html: string): string {
  if (!html) return html
  let out = html
  if (/data-cfemail|email-protection#/i.test(out)) {
    out = out.replace(CF_ELEMENT, (whole, _tag: string, hex: string) => decodeCfEmail(hex) ?? whole)
    out = out.replace(CF_HREF, (whole, q: string, hex: string) => { const a = decodeCfEmail(hex); return a ? `${q}mailto:${a}${q}` : whole })
  }
  if (/[[({]\s*at\s*[\])}]/i.test(out)) {
    out = out.replace(BRACKETED, (whole, local: string, host: string, tld: string) => {
      const addr = `${local}@${host.replace(DOT, '.')}.${tld}`.toLowerCase()
      return ADDRESS.test(addr) ? addr : whole
    })
  }
  return out
}
