// #1102 grounding against the shapes REAL search results have (measured 2026-11-14: 25 real leads through TinyFish search and Haiku).
// The first rules were written against invented result lines ("Name - Title - Employer | LinkedIn") and refused 19 of 19 real answers.
// Real profile results have the person's name as the title and the role in the snippet, as markdown; real pages put other names and
// capitalised words around the person. TEST-ONLY: every person, company and URL here is invented; only the SHAPE of each line is real.
import test from 'node:test'
import assert from 'node:assert/strict'
import { groundPerson, researchQueries, type ResearchInput, type Source } from '../lib/people/contact-research.ts'

const IN: ResearchInput = { company: 'Pagewake', domain: 'pagewake.example', roles: ['Vice President of Sales', 'Senior Director of Sales', 'Chief Revenue Officer'], where: [] }
const PROFILE_URL = 'https://linkedin.com/in/dana-okoye-test'
const profile = (title: string, text: string): Source[] => [{ id: 'S1', kind: 'search', url: PROFILE_URL, title, text }]
const ans = (title: string, quote: string, name = 'Dana Okoye') => ({ name, title, source: 'S1', quote, linkedin_source: 'S1' })
const why = (g: ReturnType<typeof groundPerson>) => ('refused' in g ? g.refused : `kept:${g.person.title}`)

test('#1102 real profile results: the name is the result title and the role is in the snippet; the person is read, and only the website tie stops it', () => {
  // Each of these is a current position at the company, stated by the person's own profile result. None names the company's website
  // (a profile result almost never does), so each is refused by the website tie and by nothing before it.
  const shapes: [string, Source[], ReturnType<typeof ans>][] = [
    ['"### Title at Company - **Dates:** ... – Present"', profile('Dana Okoye', '### Founder at Pagewake - **Dates:** March 2022 – Present - **Location:** London, England ### Director at Tutorhive - **Dates:** January 2020 – Present'), ans('Founder', 'Founder at Pagewake')],
    ['"Title. Company. Jan 2024 - Present"', profile('Dana Okoye - Pagewake', 'Pagewake. 4 years 11 months. Vice President of Sales. Pagewake. Jan 2024 - Present 2 years 11 months. Senior Director of Sales. Pagewake: Omnichannel Personalization.'), ans('Vice President of Sales', 'Vice President of Sales. Pagewake. Jan 2024 - Present')],
    ['"Name. Title @ Company."', profile('Dana Okoye - Co-Founder and CEO @ Pagewake', 'Dana Okoye. Co-Founder and CEO @ Pagewake. Stafford University. London, England, United Kingdom.'), ans('Co-Founder and CEO', 'Dana Okoye. Co-Founder and CEO @ Pagewake.')],
    ['"# Name Title at Company. Tagline"', profile('Dana Okoye', '# Dana Okoye Co-Founder & CEO at Pagewake. World models for extreme physics.'), ans('Co-Founder & CEO', 'Dana Okoye Co-Founder & CEO at Pagewake')],
    ['a credential after the name in the result title', profile('Dana Okoye, PhD', '### Co-Founder & CEO at Pagewake - **Dates:** August 2025 – Present - **Location:** Greater London'), ans('Co-Founder & CEO', 'Co-Founder & CEO at Pagewake')],
  ]
  for (const [what, sources, a] of shapes) assert.equal(why(groundPerson(a, sources, IN)), 'company_unconfirmed', what)
  // The model left the company in the title ("CEO, Pagewake"): the stored title is the title alone.
  const g = groundPerson(ans('CEO, Pagewake', 'CEO, Pagewake – Leading the development of the first network for residents.'), profile('Dana Okoye - Pagewake; London Tech Equity', 'CEO, Pagewake – Leading the development of the first network for residents. See pagewake.example'), IN)
  assert.ok(!('refused' in g), JSON.stringify(g)); assert.equal(!('refused' in g) && g.person.title, 'CEO')
})

test('#1102 real profile results: kept only with the website named; the profile URL is the one the search returned', () => {
  const text = 'CEO at Pagewake - **Dates:** October 2021 – Present ### CTO at Pagewake - **Dates:** April 2014 – October 2021 - **Location:** London CTO and Cofounder of https://www.pagewake.example'
  const g = groundPerson(ans('CEO', 'CEO at Pagewake'), profile('Dana Okoye', text), IN)
  assert.deepEqual(g, { person: { name: 'Dana Okoye', title: 'CEO', linkedin: PROFILE_URL, source_url: PROFILE_URL, quote: 'CEO at Pagewake', place: 'no_geography' }, linkedin_refused: null })
  // The same profile, the EARLIER position (its dates end in 2021): past.
  assert.equal(why(groundPerson(ans('CTO', 'CTO at Pagewake'), profile('Dana Okoye', text), { ...IN, roles: ['CTO'] })), 'past_role')
  // A lead with no confirmed website can never be tied: refused, whatever the profile says.
  assert.equal(why(groundPerson(ans('CEO', 'CEO at Pagewake'), profile('Dana Okoye', text), { ...IN, domain: null })), 'company_unconfirmed')
})

test('#1102 real profile results: wrong people are still refused', () => {
  const cases: [string, Source[], ReturnType<typeof ans>, string][] = [
    ['the profile is someone else\'s', profile('Sam Lee', '### Founder at Pagewake - **Dates:** March 2022 – Present. pagewake.example'), ans('Founder', 'Founder at Pagewake'), 'profile_names_someone_else'],
    ['an older position with no dates, listed after a current one', profile('Dana Okoye - Pagewake', 'Vice President of Sales. Pagewake. Jan 2024 - Present 2 years 11 months. Senior Director of Sales. Pagewake: Omnichannel. pagewake.example'), ans('Senior Director of Sales', 'Senior Director of Sales. Pagewake'), 'past_role'],
    ['a longer business name', profile('Dana Okoye', '### Founder at Pagewake Labs - **Dates:** March 2022 – Present. pagewake.example'), ans('Founder', 'Founder at Pagewake Labs'), 'profile_does_not_give_title_at_company'],   // the website is named, the title is at the longer-named business
    ['the title is for several firms, this one named last', profile('Dana Okoye', '### Chief Revenue Officer for two firms at Northgate Dental and Pagewake - **Dates:** March 2017 – Present. pagewake.example'), ans('Chief Revenue Officer', 'Chief Revenue Officer for two firms at Northgate Dental and Pagewake'), 'profile_does_not_give_title_at_company'],
    ['a former role', profile('Dana Okoye', 'Former Founder at Pagewake. Now advising startups. pagewake.example'), ans('Founder', 'Former Founder at Pagewake'), 'past_role'],
    ['the title is at ANOTHER company on the same profile', profile('Dana Okoye', '### Founder at Tutorhive - **Dates:** 2020 – Present ### Sales intern at Pagewake - **Dates:** 2015 – 2016. pagewake.example'), ans('Founder', 'Founder at Tutorhive'), 'profile_does_not_give_title_at_company'],
    ['a title with words that are not a title', profile('Dana Okoye', '# Dana Okoye VP of Sales, Irrigation, Plumbing & Electrical at Pagewake'), ans('VP of Sales, Irrigation, Plumbing & Electrical', 'VP of Sales, Irrigation, Plumbing & Electrical at Pagewake'), 'title_has_other_words'],
    ['an assistant to the role the scan asked for', profile('Dana Okoye', '### Assistant Vice President of Sales at Pagewake - **Dates:** 2024 – Present. pagewake.example'), ans('Assistant Vice President of Sales', 'Assistant Vice President of Sales at Pagewake'), 'title_has_other_words'],
  ]
  for (const [what, sources, a, reason] of cases) assert.equal(why(groundPerson(a, sources, IN)), reason, what)
})

test('#1102 real pages on the company\'s own site: a title tied to the company by the sentence is kept, whatever else is on the page', () => {
  const own = (text: string, kind: 'search' | 'page' = 'search', title = 'Pagewake Webinar: Forecasting for Predictable Revenue Growth'): Source[] => [{ id: 'S1', kind, url: 'https://www.pagewake.example/resources/webinar', title, text }]
  const a = (title: string, quote: string) => ({ name: 'Dana Okoye', title, source: 'S1', quote, linkedin_source: null })
  const good: [string, Source[], ReturnType<typeof a>][] = [
    ['a speaker list ("Speakers: Name, Title, Company; Other Name, ...")', own('Watch on-demand now and start forecasting with confidence. Speakers: Dana Okoye, Chief Revenue Officer, Pagewake; Matt Hunt, Sr. Director of Product ...'), a('Chief Revenue Officer', 'Dana Okoye, Chief Revenue Officer, Pagewake')],
    ['a press story ("said Name, CEO and co-founder of Company."), with the founders named again further down', own('Backed by alumni of Northgate, Pagewake is deploying agents for manufacturers. "The physical world is in its biggest cycle in history," said Dana Okoye, CEO and co-founder of Pagewake. "The companies that build the best tools will win." The funding arrives as teams face pressure. Founded by Dana Okoye (CEO) and Odran Dunne (CTO), Pagewake launched in July 2025 and is based in London.', 'page', 'Pagewake raises $18M'), a('CEO and co-founder', 'said Dana Okoye, CEO and co-founder of Pagewake.')],
    ['markdown bold around the name and title', own('**Dana Okoye, CEO and co-Founder**, Pagewake, comments: “I’m proud of what Pagewake has achieved already.”', 'search', 'Pagewake announces funding | Pagewake'), a('CEO and co-Founder', 'Dana Okoye, CEO and co-Founder, Pagewake')],
    ['a role the scan asked for by name, though it is a vice-president', own('Speakers: Dana Okoye, Vice President of Sales, Pagewake; Matt Hunt, Product.'), a('Vice President of Sales', 'Dana Okoye, Vice President of Sales, Pagewake')],
  ]
  for (const [what, sources, x] of good) { const g = groundPerson(x, sources, IN); assert.ok(!('refused' in g), `${what}: ${JSON.stringify(g)}`); assert.equal(!('refused' in g) && g.person.source_url, 'https://www.pagewake.example/resources/webinar') }
  // A vice-president the scan did NOT ask for is not a decision-maker.
  assert.equal(why(groundPerson(a('Vice President of Sales', 'Dana Okoye, Vice President of Sales, Pagewake'), own('Speakers: Dana Okoye, Vice President of Sales, Pagewake; Matt Hunt, Product.'), { ...IN, roles: [] })), 'not_a_buyer_role')
  // The sentence gives her ANOTHER employer, on the company's own site (a guest speaker): refused.
  assert.equal(why(groundPerson(a('Chief Revenue Officer', 'Dana Okoye, Chief Revenue Officer, Northgate'), own('Speakers: Dana Okoye, Chief Revenue Officer, Northgate; Matt Hunt, Sr. Director of Product, Pagewake.'), IN)), 'title_at_another_organisation')
  // The company described after it is named is still the company: she owns the lead ("the franchise arm of ...").
  const off = groundPerson(a('Owner', 'Dana Okoye, Owner of Pagewake'), [{ id: 'S1', kind: 'search', url: 'https://news.example.test/x', title: 'Local business news', text: 'Dana Okoye, Owner of Pagewake, the franchise arm of Globex Health. See pagewake.example for hours.' }], IN)
  assert.ok(!('refused' in off), JSON.stringify(off))
})

test('#1102 a lead with a confirmed website searches its own site first; one with none searches public profiles', () => {
  assert.deepEqual(researchQueries(IN), ['site:pagewake.example ("Vice President of Sales" OR "Senior Director of Sales" OR "Chief Revenue Officer" OR "Founder" OR "Co-founder")', '"Pagewake" ("Vice President of Sales" OR "Senior Director of Sales" OR "Chief Revenue Officer" OR "Founder")'])
  assert.match(researchQueries({ ...IN, domain: null })[0], /^site:linkedin\.com\/in "Pagewake" /)
  // A value that is not a host name is never put after site:
  assert.match(researchQueries({ ...IN, domain: 'pagewake.example OR site:evil.test' })[0], /^site:linkedin\.com\/in /)
})
