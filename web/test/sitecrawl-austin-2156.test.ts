import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractContacts, extractPeople } from '../lib/connectors/sitecrawl.ts'

// #2156: Austin agency pages that sitecrawl already visits but reads nothing from — the site is
// known, yet no named buyer and no published email survives extraction. Each fixture follows the
// shape of a real page (DigiSearch, Uncommon Logic, Zilker Media): a plus-tagged role mailbox in
// JSON-LD, an array-valued contactPoint email, JSON-LD founders with no jobTitle, and a team grid
// that carries each name in a linked heading with its title in the heading below.

const emails = (html: string, url: string, site: string) => extractContacts(html, url, site).filter(f => f.kind === 'email').map(f => f.value)
const people = (html: string, url: string) => extractPeople(html, url).map(f => f.value)

test('a published plus-tagged role mailbox in JSON-LD is found, exactly as published', () => {
  const home = (email: string) => `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"DigiSearch","url":"https://www.digisearch.com/","email":"${email}"}</script></head><body><h1>DigiSearch</h1><p>Austin search marketing, measured in revenue.</p></body></html>`
  assert.deepEqual(emails(home('info+site@digisearch.com'), 'https://www.digisearch.com/', 'digisearch.com'), ['info+site@digisearch.com'])
  // control: a plus-tagged personal mailbox is not a role mailbox, with or without the tag
  assert.deepEqual(emails(home('jane+news@digisearch.com'), 'https://www.digisearch.com/', 'digisearch.com'), [])
})

test('an array-valued contactPoint email yields every published role address', () => {
  const home = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Uncommon Logic","url":"https://www.uncommonlogic.com/","contactPoint":{"@type":"ContactPoint","contactType":"Customer Support","email":["hello@uncommonlogic.com","contactus@uncommonlogic.com"]}}</script></head><body><h1>Uncommon Logic</h1></body></html>`
  assert.deepEqual(emails(home, 'https://www.uncommonlogic.com/', 'uncommonlogic.com').sort(), ['contactus@uncommonlogic.com', 'hello@uncommonlogic.com'])
})

test("JSON-LD founders of the page's own organisation are listed without a jobTitle; a title-less employee is not", () => {
  const home = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Uncommon Logic","founders":[{"@type":"Person","name":"Jim McKinley"},{"@type":"Person","name":"Jeff Hoogendam"}],"employee":[{"@type":"Person","name":"Pat Morgan"}]}</script></head><body><h1>Uncommon Logic</h1></body></html>`
  assert.deepEqual(people(home, 'https://www.uncommonlogic.com/'), ['Jim McKinley, Founder', 'Jeff Hoogendam, Founder'])
})

const TEAM_PAGE = `<html><body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/services/">Services</a></li><li><a href="/contact/">Contact Us</a></li></ul></nav>
<h1>Meet the Team</h1>
<p>We are a digital marketing agency in Austin, Texas, and our strategists, analysts and creatives help growing brands turn search, social and paid media into revenue that owners can measure. Every engagement begins with research and ends with reporting that a client can actually read and act on.</p>
<div class="team-grid">
<div class="member"><h2><a href="/our-team/barbara-cavness/">Barbara Cavness</a></h2><h3>CEO</h3></div>
<div class="member"><h2><a href="/our-team/jim-mckinley/">Jim McKinley</a></h2><h3>Co-Founder</h3></div>
<div class="member"><h2><a href="/our-team/jeff-hoogendam/">Jeff Hoogendam</a></h2><h3>Co-Founder</h3></div>
<div class="member"><h2><a href="/our-team/annie-duke/">Annie Duke</a></h2></div>
</div>
<div class="testimonial"><p>They rebuilt our pipeline and the board finally gets reporting it trusts.</p><p>Grace Hopper</p><p>Founder</p></div>
<p>Offices on Balcones Drive, minutes from downtown, with parking for clients who visit in person and coffee for anyone who stays to talk through the numbers.</p>
</body></html>`

test('a team grid of linked name headings over title headings lists the titled leaders only', () => {
  // Barbara, Jim and Jeff pair with the title heading under their name; Annie Duke's linked
  // heading has no title under it, the nav's "Contact Us" is a control label, and Grace Hopper
  // sits in a testimonial block: none of them is listed.
  assert.deepEqual(people(TEAM_PAGE, 'https://www.uncommonlogic.com/about/our-team/'), ['Barbara Cavness, CEO', 'Jim McKinley, Co-Founder', 'Jeff Hoogendam, Co-Founder'])
})

test('control: a contact page with a visible role address and a personal address is unchanged', () => {
  const contact = `<html><body><h1>Contact</h1><p>Reach the studio at <a href="mailto:info@zilkermedia.com">info@zilkermedia.com</a> for new business, or write to <a href="mailto:nichole@zilkermedia.com">nichole@zilkermedia.com</a> about an existing engagement.</p></body></html>`
  assert.deepEqual(emails(contact, 'https://zilkermedia.com/contact/', 'zilkermedia.com'), ['info@zilkermedia.com'])
})

test('control: the common name-and-title paragraph shape on an about page is unchanged', () => {
  const about = `<html><body><h1>About Our Practice</h1>
<p>Our practice has cared for families in the neighbourhood for over twenty years, offering gentle dentistry, honest advice and appointments that run on time for busy parents and their children.</p>
<p>Daniel Kim</p><p>Founder</p>
<footer><a href="mailto:info@brightpathdental.example">info@brightpathdental.example</a></footer></body></html>`
  assert.deepEqual(people(about, 'https://brightpathdental.example/about'), ['Daniel Kim, Founder'])
})
