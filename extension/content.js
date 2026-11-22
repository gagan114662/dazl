// dazl LinkedIn Reader, in the LinkedIn tab the extension opened. It does nothing until the extension asks; then it scrolls the page
// a few times so LinkedIn renders more of the list, reads the names, titles and profile links already on it, and answers.
const X = globalThis.dazlExtract
const sleep = ms => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 400)))
const text = el => (el ? (el.innerText || el.textContent || '') : '').trim()
const first = (root, sels) => { for (const s of sels) { const e = root.querySelector(s); if (e && text(e)) return e } return null }

async function scroll(times) {
  for (let i = 0; i < times; i++) { window.scrollBy(0, Math.round(window.innerHeight * 0.9)); await sleep(1500) }
}
function cards(cardSel, nameSels, titleSels) {
  const out = []
  for (const card of document.querySelectorAll(cardSel)) {
    const a = card.querySelector('a[href*="/in/"]')
    if (!a) continue
    out.push({ href: a.getAttribute('href'), name: text(first(card, nameSels)) || text(a), title: text(first(card, titleSels)) })
  }
  return out
}
function companyPeople() {
  return X.people(cards('li.org-people-profile-card__card-spacing, li.grid, .org-people-profile-card, .artdeco-entity-lockup',
    ['.org-people-profile-card__profile-title', '.artdeco-entity-lockup__title', '[aria-hidden="true"]'],
    ['.artdeco-entity-lockup__subtitle', '.lt-line-clamp--multi-line', '.org-people-profile-card__profile-info .t-14']))
}
function postEngagement() {
  return X.people(cards('article.comments-comment-entity, article.comments-comment-item, .comments-comment-item',
    ['.comments-comment-meta__description-title', '.comments-post-meta__name-text', '[aria-hidden="true"]'],
    ['.comments-comment-meta__description-subtitle', '.comments-post-meta__headline']))
}
function profile() {
  const name = text(first(document, ['main h1', 'h1']))
  const headline = text(first(document, ['main .text-body-medium.break-words', 'main .text-body-medium']))
  const p = X.people([{ href: location.href, name, title: headline }])[0]
  return p || null
}
async function read(kind) {
  const why = X.blockedReason(location.href)
  if (why) return { error: why }
  await sleep(2000)
  if (kind === 'profile') { const person = profile(); return person ? { person } : { error: 'extract_failed' } }
  await scroll(kind === 'company_people' ? 5 : 3)
  return { people: kind === 'company_people' ? companyPeople() : postEngagement() }
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== 'dazl-read') return false
  read(msg.kind).then(reply, () => reply({ error: 'extract_failed' }))
  return true
})
