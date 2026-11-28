// dazl LinkedIn Reader: turns what is ON the page into people. Pure functions over plain records, so they run in the page
// (content.js collects the records) and in dazl's tests. No click, no request: it only reads text and links already rendered.
;(function (root) {
  const squash = s => String(s || '').replace(/\s+/g, ' ').trim()
  // LinkedIn repeats the name for screen readers and adds badges; keep the visible name only.
  function cleanName(s) {
    let n = squash(s).replace(/^View\s+/i, '').replace(/[’']s\s+profile.*$/i, '')
    n = n.replace(/\s*[•·]\s*(1st|2nd|3rd\+?|3rd|Following|Author)\b.*$/i, '').replace(/\s+(1st|2nd|3rd\+?)\s+degree connection.*$/i, '')
    const half = n.length / 2
    if (n.length > 3 && Number.isInteger(half) && n.slice(0, half) === n.slice(half)) n = n.slice(0, half)
    return n.slice(0, 120)
  }
  function profileUrl(href) {
    try {
      const u = new URL(href, 'https://www.linkedin.com')
      const m = /^\/in\/([A-Za-z0-9%_-]{2,100})\/?/.exec(u.pathname)
      return u.hostname.endsWith('linkedin.com') && m ? `https://www.linkedin.com/in/${m[1]}/` : null
    } catch { return null }
  }
  // records: [{ href, name, title }] as read from cards. Returns people with a name, a title and a profile URL; one per URL.
  function people(records) {
    const out = [], seen = new Set()
    for (const r of records || []) {
      const url = profileUrl(r && r.href), name = cleanName(r && r.name), title = squash(r && r.title).slice(0, 200)
      if (!url || !name || !title || /^linkedin member$/i.test(name) || seen.has(url)) continue
      seen.add(url); out.push({ name, title, profile_url: url })
      if (out.length >= 100) break
    }
    return out
  }
  // Which page LinkedIn actually showed: its sign-in wall or a security check instead of the page asked for.
  function blockedReason(href) {
    const p = (() => { try { return new URL(href).pathname } catch { return '' } })()
    if (/^\/(checkpoint|challenge)\b/.test(p)) return 'challenge'
    if (/^\/(login|authwall|uas\/login|signup)\b/.test(p)) return 'login_required'
    if (/^\/404\b/.test(p)) return 'not_found'
    return null
  }
  // What is wrong with the page in front of us, or null when it is a signed-in LinkedIn page that can be read. A page is only read
  // when it carries LinkedIn's signed-in navigation bar: a security check, a sign-in prompt or anything unrecognised is reported
  // as such and never as "0 people". page: { href, hasNav, hasChallenge, hasSignIn, title } collected by content.js.
  function pageProblem(page) {
    const byAddress = blockedReason(page && page.href)
    if (byAddress) return byAddress
    if (page && page.hasNav) return null
    if (page && (page.hasChallenge || /just a moment|security verification|security check/i.test(String(page.title || '')))) return 'challenge'
    if (page && page.hasSignIn) return 'login_required'
    return 'extract_failed'
  }
  // A post's commenters as the post page shows them: the person plus their own comment, one per profile URL (#1588). A record
  // marked action 'like' is a reaction row if LinkedIn renders one without a click; every other card a post page shows is a
  // comment. Older builds send plain people records: those read as commenters with no comment text.
  function postEngagers(records) {
    const out = [], seen = new Set()
    for (const r of records || []) {
      const url = profileUrl(r && r.href), name = cleanName(r && r.name), title = squash(r && r.title).slice(0, 200)
      if (!url || !name || !title || /^linkedin member$/i.test(name) || seen.has(url)) continue
      seen.add(url)
      const action = r && r.action === 'like' ? 'like' : 'comment'
      const comment = squash(r && r.comment).slice(0, 500)
      out.push(action === 'comment' && comment ? { name, title, profile_url: url, action, comment } : { name, title, profile_url: url, action })
      if (out.length >= 100) break
    }
    return out
  }
  // A post link as a competitor's own page shows it: the post's own URL, or null.
  function postUrl(href) {
    try {
      const u = new URL(href, 'https://www.linkedin.com')
      if (!u.hostname.endsWith('linkedin.com')) return null
      const m = /^\/(posts\/[A-Za-z0-9%_.-]{3,200}|feed\/update\/urn:li:activity:\d{5,25})\/?/.exec(u.pathname)
      return m ? `https://www.linkedin.com/${m[1]}/` : null
    } catch { return null }
  }
  // The post's date as the page shows it: its own timestamp (a YYYY-MM-DD or a full datetime), or a relative marker
  // ("45m", "3h", "3d", "2w", "5mo", "1y"). A marker names a RANGE of days, so the day returned is the OLDEST one it
  // could mean (2w -> 14-20 days ago -> the 20th): never newer than the truth, so the server's 30-day window never
  // lets an old post in. Anything else is no date, never a guess.
  function postDate(shown) {
    const t = squash(shown)
    const abs = /^(\d{4}-\d{2}-\d{2})/.exec(t)
    if (abs) return abs[1]
    const rel = /^(\d+)\s*(m(?!o)|h|d|w|mo|y)/i.exec(t)
    if (!rel) return null
    const n = Number(rel[1]), u = rel[2].toLowerCase()
    const days = u === 'y' ? (n + 1) * 365 - 1 : u === 'mo' ? (n + 1) * 30 - 1 : u === 'w' ? (n + 1) * 7 - 1 : u === 'd' ? n + 1 : 1
    const d = new Date(Date.now() - days * 86400000)
    const p = x => String(x).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  // True when the day is the page's own timestamp; false when a relative marker was resolved to its oldest day.
  function postDateExact(shown) { return /^\d{4}-\d{2}-\d{2}/.test(squash(shown)) }
  // A page URL of the shape a competitor's own page or a person's profile has, or null.
  function pageUrl(href) {
    try {
      const u = new URL(href, 'https://www.linkedin.com')
      if (!u.hostname.endsWith('linkedin.com')) return null
      const m = /^\/(company\/[A-Za-z0-9%_.-]{1,100}|in\/[A-Za-z0-9%_-]{2,100})\/?/.exec(u.pathname)
      return m ? `https://www.linkedin.com/${m[1]}/` : null
    } catch { return null }
  }
  // The posts a competitor's own page links to: the post's own URL, its own date, and the page that authored it.
  // A post whose author the page does not name is dropped: a link is not proof the competitor wrote it (#1588).
  function companyPosts(records) {
    const out = [], seen = new Set()
    for (const r of records || []) {
      const url = postUrl(r && r.href)
      if (!url || seen.has(url)) continue
      const author = pageUrl(r && r.author)
      if (!author) continue
      const date = postDate(r && r.date)
      seen.add(url); out.push({ url, date, approx: date != null && !postDateExact(r && r.date), author })
      if (out.length >= 25) break
    }
    return out
  }
  root.dazlExtract = { people, postEngagers, companyPosts, postUrl, postDate, postDateExact, pageUrl, profileUrl, cleanName, blockedReason, pageProblem }
})(typeof globalThis !== 'undefined' ? globalThis : this)
