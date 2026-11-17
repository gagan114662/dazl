// #1242: linear (indexOf) replacements for the backtracking patterns /<[^>]+>/g, /<(script|style|...)[\s\S]*?<\/\1>/gi and
// /<!--[\s\S]*?-->/g, which take tens of seconds on hostile pages full of unclosed tags. Output matches those patterns on normal HTML.

// Same as s.replace(/<[^>]+>/g, rep).
export function stripTags(s: string, rep = ' '): string {
  let out = '', i = 0
  for (;;) {
    const lt = s.indexOf('<', i)
    if (lt < 0) break
    const gt = s.indexOf('>', lt + 1)
    if (gt < 0) break                       // no '>' anywhere after: nothing further can match
    if (gt === lt + 1) { out += s.slice(i, lt + 1); i = lt + 1; continue } // "<>" is not a tag
    out += s.slice(i, lt) + rep; i = gt + 1
  }
  return out + s.slice(i)
}

// Same as s.replace(/<(t1|t2|...)[\s\S]*?<\/\1>/gi, rep): each block runs from "<tag" to the first "</tag>" after it.
export function dropBlocks(s: string, tags: string[], rep = ' '): string {
  const low = s.toLowerCase(), names = tags.map(t => t.toLowerCase())
  const nextOpen = names.map(t => low.indexOf('<' + t))
  const closeMissing = new Set<string>()
  let out = '', i = 0
  for (;;) {
    let best = -1, tag = ''
    for (let k = 0; k < names.length; k++) {
      if (closeMissing.has(names[k])) continue
      if (nextOpen[k] >= 0 && nextOpen[k] < i) nextOpen[k] = low.indexOf('<' + names[k], i)
      if (nextOpen[k] >= 0 && (best < 0 || nextOpen[k] < best)) { best = nextOpen[k]; tag = names[k] }
    }
    if (best < 0) break
    const close = low.indexOf('</' + tag + '>', best + tag.length + 1)
    if (close < 0) { closeMissing.add(tag); continue } // no closer after here, so no later open of this tag can match either
    out += s.slice(i, best) + rep; i = close + tag.length + 3
  }
  return out + s.slice(i)
}

// Same as s.replace(/<!--[\s\S]*?-->/g, rep).
export function dropComments(s: string, rep = ' '): string {
  let out = '', i = 0
  for (;;) {
    const a = s.indexOf('<!--', i)
    if (a < 0) break
    const b = s.indexOf('-->', a + 4)
    if (b < 0) break
    out += s.slice(i, a) + rep; i = b + 3
  }
  return out + s.slice(i)
}
