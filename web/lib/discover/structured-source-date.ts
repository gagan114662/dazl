import { parse, type DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const attr = (node: Element, name: string) => node.attrs.find(entry => entry.name === name)?.value
const DAY_MS = 86_400_000

function calendarDay(value: unknown, now: Date, maxAgeDays: number): string | null {
  if (typeof value !== 'string') return null
  const stamp = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/i.exec(value.trim())
  if (!stamp) return null
  const day = stamp[1]
  const time = Date.parse(day)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) return null
  const age = Math.floor(now.getTime() / DAY_MS) - time / DAY_MS
  return age >= 0 && age <= maxAgeDays ? day : null
}

function describesPage(value: unknown, page?: URL): boolean {
  if (!page || value == null) return true
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const declared = new URL(value, page)
    return declared.origin === page.origin &&
      declared.pathname.replace(/\/+$/, '') === page.pathname.replace(/\/+$/, '') &&
      (!declared.search || declared.search === page.search)
  } catch { return false }
}

function collectJson(value: unknown, postings: unknown[], publications: unknown[], page?: URL, standalone = false) {
  const pending = [value]
  while (pending.length) {
    const entry = pending.pop()
    if (Array.isArray(entry)) {
      for (const item of entry) pending.push(item)
    } else if (entry && typeof entry === 'object') {
      const row = entry as Record<string, unknown>
      const types = Array.isArray(row['@type']) ? row['@type'] : [row['@type']]
      const names = types.map(type => typeof type === 'string' ? type.replace(/^https?:\/\/schema\.org\//, '') : '')
      if (names.includes('JobPosting') && describesPage(row.url, page)) postings.push(row.datePosted)
      if (names.some(name => /^(?:Article|NewsArticle|BlogPosting|PressRelease)$/.test(name)) ||
          (standalone && entry === value && row['@type'] === undefined)) {
        publications.push(row.datePublished)
      }
      if (row['@graph']) pending.push(row['@graph'])
    }
  }
}

function timeKind(node: Element): 'posted' | 'published' | null {
  const property = attr(node, 'itemprop')
  if (property) {
    if (property === 'datePosted') return 'posted'
    if (property === 'datePublished') return 'published'
    return null
  }
  const siblings = node.parentNode?.childNodes ?? []
  const previous = siblings[siblings.indexOf(node) - 1]
  const label = attr(node, 'aria-label') ?? (previous && 'value' in previous ? previous.value : '')
  if (/^\s*(?:date\s+)?posted(?:\s+on)?\s*:?\s*$/i.test(label)) return 'posted'
  if (/^\s*published(?:\s+on)?\s*:?\s*$/i.test(label)) return 'published'
  return null
}

// Only publication fields and explicitly labelled times count. Across distinct
// candidate days, leave the date unknown rather than selecting a posting.
export function structuredSourceDay(html: string, now: Date, hiring: boolean, maxAgeDays: number, page?: URL): string | null {
  const postings: unknown[] = [], publications: unknown[] = [], postingTimes: unknown[] = []
  if (html.trimStart().startsWith('{')) {
    try { collectJson(JSON.parse(html), postings, publications, page, true) } catch { return null }
  } else {
    const pending: Node[] = [parse(html)]
    while (pending.length) {
      const node = pending.pop()!
      if ('tagName' in node) {
        if (node.tagName === 'script' && attr(node, 'type')?.trim().toLowerCase() === 'application/ld+json') {
          const raw = node.childNodes.map(child => 'value' in child ? child.value : '').join('')
          try { collectJson(JSON.parse(raw), postings, publications, page) } catch { /* invalid JSON-LD */ }
        } else if (node.tagName === 'meta') {
          if (/^(?:article:published_time|datePublished)$/i.test(attr(node, 'property') ?? attr(node, 'name') ?? attr(node, 'itemprop') ?? '')) {
            publications.push(attr(node, 'content'))
          }
        } else if (node.tagName === 'time') {
          const kind = timeKind(node)
          if (kind === 'posted') postingTimes.push(attr(node, 'datetime'))
          if (kind === 'published') publications.push(attr(node, 'datetime'))
        }
      }
      if ('childNodes' in node) for (const child of node.childNodes) pending.push(child)
    }
  }
  if (hiring && postings.length > 1) return null
  const values = hiring ? [...postings, ...postingTimes] : publications
  const days = new Set(values.filter(value => value != null).map(value => calendarDay(value, now, maxAgeDays)))
  return days.size === 1 ? [...days][0] : null
}
