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
export function decodeCfEmail(hex: string, strictDisplay = false): string | null {
  if (!/^(?:[0-9a-f]{2}){3,300}$/i.test(hex)) return null
  const key = parseInt(hex.slice(0, 2), 16)
  const bytes: number[] = []
  for (let i = 2; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16) ^ key)
  let out: string
  try { out = new TextDecoder('utf-8', { fatal: true, ignoreBOM: strictDisplay }).decode(new Uint8Array(bytes)) } catch { return null }
  if (strictDisplay) return ADDRESS.test(out) ? out : null
  out = out.trim()
  // A protected href may carry "?subject=..." after the address; the address is what the visitor's mail app receives.
  const addr = out.split('?')[0]
  return ADDRESS.test(addr) ? addr.toLowerCase() : null
}

const CF_ELEMENT = /(<([a-z][a-z0-9]*)\b[^>]*\bdata-cfemail\s*=\s*["']([0-9a-f]+)["'][^>]*>)([\s\S]*?)(<\/\2\s*>)/gi
const PLACEHOLDER = /\[\s*email(?:&#160;|&nbsp;|&#xa0;|\u00a0|\s)+protected\s*\]/i
// Cloudflare's OWN wrapper and nothing else: class "__cf_email__" plus data-cfemail, no other attribute, the placeholder as its only content.
// That wrapper was cut out of the author's text node by Cloudflare, so unwrapping it gives back exactly the text the author wrote.
const BARE_WRAPPER = /^<span\s+(?:class\s*=\s*["']__cf_email__["']\s+data-cfemail\s*=\s*["'][0-9a-f]+["']|data-cfemail\s*=\s*["'][0-9a-f]+["']\s+class\s*=\s*["']__cf_email__["'])\s*>$/i
const CF_HREF = /(["'])(?:https?:\/\/[^"'\s]*?)?\/cdn-cgi\/l\/email-protection#([0-9a-f]+)\1/gi
const BRACKETED = /\b([a-z0-9][a-z0-9._%+-]{0,63})\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\})\s*([a-z0-9][a-z0-9-]{0,62}(?:(?:\.|\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*)[a-z0-9-]{1,63})*?)(?:\.|\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*)([a-z]{2,24})\b(?![.-]?[a-z0-9])/gi
const DOT = /\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*/gi

export function revealEmails(html: string): string {
  if (!html) return html
  let out = html
  if (/data-cfemail|email-protection#/i.test(out)) {
    // Ziggy review 1288-F1: only the placeholder is replaced. Any element that carries anything beyond Cloudflare's bare wrapper keeps its
    // tags and every attribute (aria-label / title / data-* may name a DIFFERENT person), so the text on either side is never joined into one
    // text node and addressContexts still sees that evidence. Content that is not the placeholder (nested markup) is left untouched.
    out = out.replace(CF_ELEMENT, (whole, open: string, _tag: string, hex: string, inner: string, close: string) => {
      const addr = decodeCfEmail(hex)
      if (!addr || !PLACEHOLDER.test(inner)) return whole
      if (BARE_WRAPPER.test(open) && PLACEHOLDER.test(inner) && inner.replace(PLACEHOLDER, '').trim() === '') return addr
      return open + inner.replace(PLACEHOLDER, addr) + close
    })
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

// Display-only: decode one whole, visible spelling, never an HTML attribute/href or fragments.
const DISPLAY_CF = /<span\s+(?:class\s*=\s*["']__cf_email__["']\s+data-cfemail\s*=\s*["']([0-9a-f]{6,600})["']|data-cfemail\s*=\s*["']([0-9a-f]{6,600})["']\s+class\s*=\s*["']__cf_email__["'])\s*>\[\s*email(?:&#160;|&nbsp;|&#xa0;|\u00a0|\s)+protected\s*\]<\/span\s*>/gi
const DISPLAY_TAG = /<\/?[A-Za-z][\w:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g
const DISPLAY_INVISIBLE = new Set('script style noscript svg template blockquote head title details dialog iframe textarea xmp plaintext noembed noframes object canvas select'.split(' '))
const DISPLAY_RAW = new Set('script style title iframe textarea xmp plaintext noembed noframes'.split(' '))
const DISPLAY_VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))
const DISPLAY_OPAQUE = '\uFFFC'
const displayHidden = (tag: string) => {
  if (/\s(?:hidden|inert)(?=\s|=|\/?>)/i.test(tag)) return true
  // Only a literal false is an affirmative visible state. Entity/CSS escape decoding is intentionally unsupported.
  const values = (key: string) => [...tag.matchAll(new RegExp(`\\s${key}(?=\\s|=|/?>)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?`, 'gi'))]
    .map(m => m[1] ?? m[2] ?? m[3] ?? '')
  if (values('aria-hidden').some(value => value.toLowerCase() !== 'false')) return true
  if (values('class').some(value => /[&\\]|(?:^|\s)(?:hidden|hide|sr-only|visually-hidden|d-none)(?:\s|$)/i.test(value))) return true
  // No CSS interpreter: even seemingly benign inline style is outside the optional decode lane.
  return values('style').length > 0
}
const leftDisplay = (left: string) => /[ \t\r\n(]$/u.test(left)
// No HTML or CSS renderer: a tag in general is not a delimiter. Recognize only the
// actual structural end of the current standard block. Inline/unknown markup abstains.
const DISPLAY_BLOCK_END = /^<\/(address|article|aside|dd|div|dt|figcaption|footer|h[1-6]|header|li|main|p|pre|section|td|th)\s*>/i
const rightDisplay = (right: string, parent?: string) => {
  const edge = (tail: string) => tail === '' || /^\s/u.test(tail) ||
    (parent !== undefined && DISPLAY_BLOCK_END.exec(tail)?.[1].toLowerCase() === parent)
  return edge(right) || right.startsWith(')') || (/^[.,;!?]/.test(right) && edge(right.slice(1)))
}

export function revealDisplayEmails(visible: string): { html: string; offsets: Set<number> } {
  const offsets = new Set<number>()
  if (visible.length > 512_000 || !/data-cfemail|[[({]\s*at\s*[\])}]/i.test(visible)) return { html: visible, offsets }
  // The optional decoder does not parse arbitrary declarations or processing
  // instructions; their contents could masquerade as a text node. Allow only a
  // canonical leading HTML5 doctype, treating it as opaque rather than deleting it.
  visible = visible.replace(/^(\s*)<!doctype html\s*>/i, '$1' + DISPLAY_OPAQUE)
  if (/<[!?]/.test(visible)) return { html: visible, offsets }
  // Optionally hide markup without joining text nodes; known hidden ancestors are opaque.
  const tags = [...visible.matchAll(DISPLAY_TAG)]
  const clouds = new Map([...visible.matchAll(DISPLAY_CF)].map(m => [m.index, m]))
  const out: string[] = []
  const open: { name: string; hidden: boolean }[] = []
  let from = 0, hidden = false, length = 0, raw = ''
  const push = (part: string) => { out.push(part); length += part.length }
  const appendText = (end: number) => {
    if (end <= from) return
    if (hidden) { push(DISPLAY_OPAQUE); return }
    const text = visible.slice(from, end)
    if (text.length > 8_192) { push(text); return }
    // Only one text node; line/tab/control boundaries can't assemble an address across records.
    let shortened = 0
    push(text.replace(BRACKETED, (whole, local: string, host: string, tld: string, offset: number) => {
      if (!leftDisplay(text.slice(Math.max(0, offset - 1), offset)) || !rightDisplay(visible.slice(from + offset + whole.length, from + offset + whole.length + 32), open.at(-1)?.name) ||
          /[\r\n\t<>&\uFFFC]/u.test(whole)) return whole
      const addr = `${local}@${host.replace(DOT, '.')}.${tld}`
      if (!ADDRESS.test(addr)) return whole
      offsets.add(length + offset - shortened)
      shortened += whole.length - addr.length
      return addr
    }))
  }
  for (const tag of tags) {
    if (tag.index < from) continue
    const name = /^<\/?([\w:-]+)/.exec(tag[0])![1].toLowerCase()
    const closing = tag[0].startsWith('</')
    // In HTML raw/RCDATA elements, fake tags (including a parent's closing tag) are text.
    // Plaintext has no closing delimiter. Other raw roots exit only at their own end tag.
    if (raw && (raw === 'plaintext' || !closing || raw !== name)) continue
    if (raw) raw = ''
    appendText(tag.index)
    const cloud = clouds.get(tag.index)
    if (cloud && !hidden && leftDisplay(visible.slice(Math.max(from, tag.index - 1), tag.index)) &&
        rightDisplay(visible.slice(tag.index + cloud[0].length, tag.index + cloud[0].length + 32), open.at(-1)?.name)) {
      const address = decodeCfEmail(cloud[1] ?? cloud[2], true)
      if (address) { offsets.add(length); push(address); from = tag.index + cloud[0].length; continue }
    }
    if (closing) {
      const last = open.findLastIndex(item => item.name === name)
      // No attempt to reproduce HTML error recovery across an opaque ancestor.
      if (last >= 0 && open.slice(last + 1).some(item => item.hidden)) return { html: visible, offsets: new Set() }
      if (last >= 0) open.length = last
      const parentHidden = open.at(-1)?.hidden ?? false
      push(hidden || parentHidden ? DISPLAY_OPAQUE : tag[0])
      hidden = parentHidden
    } else {
      const ownHidden = hidden || DISPLAY_INVISIBLE.has(name) || displayHidden(tag[0])
      if (!DISPLAY_VOID.has(name)) open.push({ name, hidden: ownHidden })
      if (DISPLAY_RAW.has(name)) raw = name
      if (open.length > 96) return { html: visible, offsets: new Set() }
      push(ownHidden ? DISPLAY_OPAQUE : tag[0])
      hidden = open.at(-1)?.hidden ?? false
    }
    from = tag.index + tag[0].length
  }
  appendText(visible.length)
  return { html: out.join(''), offsets }
}
