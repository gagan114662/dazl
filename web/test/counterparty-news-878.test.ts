// #878 (matrix berlin-fintech and chicago-law, 2026-11-14): 4 of 5 Berlin funding-news leads were held as "counterparty_signal". The rule
// read every news article about a company as the publisher's customer story: the publisher's name sits beside the headline and a customer
// word ("use", "joins", "is now") is somewhere in the first 3,000 characters of any article.
// FINSMES and LAWDRAGON below are the title and opening text of two real pages as dazl fetched them on 2026-11-14, cut short; the last two
// sentences of FINSMES are the standard closing of that site's funding stories, written here from the real page's wording. The other
// fixtures are synthetic and say so. The vendor-story strings are the ones the council reviewers ran against the first version of this fix.
// Pure function tests: no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { counterpartySignal } from '../lib/scan/counterparty.ts'

const cand = (company: string, source_url: string) => ({ name: '', company, contact: null, signal: '', source_url, score: 80, excerpt: '', event_date: null })
const cp = (company: string, url: string, title: string, text: string, passage = '') => counterpartySignal(cand(company, url) as never, { title, text, retrievedAt: 0 } as never, passage)
const held = (company: string, url: string, title: string, text: string) => assert.equal(cp(company, url, title, text), `source_owner:${new URL(url).hostname.replace(/^www\./, '').split('.')[0]}`, `${title} / ${text}`)
const free = (company: string, url: string, title: string, text: string) => assert.equal(cp(company, url, title, text), null, `${title} / ${text}`)

const FINSMES = 'mika Raises €6M in Seed Funding Sign in FinSMEs Intelligence USA UK Germany France Canada India Italy Submit Press Release Sign in Welcome! Log into your account your username your password Forgot your password? Password recovery Recover your password your email Search FinSMEs The Website About Venture Capital News My account Get into your account. Login FinSMEs Intelligence Home Germany mika Raises €6M in Seed Funding By FinSMEs - September 24, 2026 Facebook Twitter WhatsApp Linkedin mika , a Berlin, Germany-based provider of an AI-native financial operating system for SMEs, raised €6M in Seed funding. The round was led by Smedvig Ventures. The company intends to use the funds to expand operations and its development efforts. Led by its founders, mika is now building an AI-native operating system that SMEs are using to run their finances.'
const LAWDRAGON = 'McGuireWoods Bolsters Insurance Recovery Practice | Lawdragon News & Features Lawyer Limelights Consultant Limelights Guides Nominations The Magazine About Shop McGuireWoods Bolsters Insurance Recovery Practice By Lawdragon News | September 8, 2026 | Press Releases , McGuireWoods News McGuireWoods continues the expansion of its nationally ranked Insurance Recovery Practice Group with the arrival of partner Andrew M. Barrios , who brings more than a decade of complex litigation experience. Barrios joins the firm s Chicago office to help lead the growth of the insurance recovery practice in that market.'

test('a news article about a company is not its publisher\'s customer story (real page shapes: FinSMEs, Lawdragon)', () => {
  free('mika', 'https://finsmes.com/2026/09/mika-raises-e6m-in-seed-funding.html', 'mika Raises €6M in Seed Funding', FINSMES)
  free('finmid', 'https://finsmes.com/2026/10/finmid-raises-e17m-in-series-a-extension-funding.html', 'finmid Raises €17M in Series A Extension Funding', FINSMES.replace(/mika/g, 'finmid'))
  free('McGuireWoods', 'https://lawdragon.com/press-releases/2026-09-08-mcguirewoods-bolsters-insurance-recovery-practice', 'McGuireWoods Bolsters Insurance Recovery Practice | Lawdragon', LAWDRAGON)
})

test('synthetic news shapes: a German story, an investor\'s own news page, customer words that are not about the publisher', () => {
  free('mika', 'https://startbase.de/news/mika', 'mika erhält 6 Millionen Euro für KI-native Buchhaltung | Startbase', 'Startbase News Das Berliner FinTech mika hat sechs Millionen Euro in einer Seed-Finanzierungsrunde eingesammelt. Startbase ist die Plattform für Startups. mika is now live in Germany and teams are using it daily.')
  // an investor announcing its portfolio company's round: the investor took part in the round, it is not the company's vendor
  free('Limetax', 'https://heliad.com/highlights/limetax', 'Limetax raises €36m to build Germany\'s agentic-first accounting and tax group', 'Heliad Highlights Limetax raises €36m. €6 million in pre-seed equity led by Motive Partners with participation from Activant and Heliad, and a €30 million acquisition facility. The company is now using it.')
  free('Limetax', 'https://heliad.com/x', 'Heliad news', 'Limetax joins Heliad portfolio after its pre-seed round.')
  free('Limetax', 'https://heliad.com/x', 'Limetax raises €36m | Heliad', 'Limetax will use the money to serve its customers better and win new customers. Heliad invests in fintech.')
  // customer words in a funding story
  free('mika', 'https://finsmes.com/x', 'mika Raises €6M in Seed Funding', `${FINSMES} "Our customers love the product," said the CEO.`)
  free('mika', 'https://finsmes.com/x', 'mika Raises €6M in Seed Funding', FINSMES.replace('raised €6M in Seed funding.', 'raised €6M in Seed funding as customer demand grows.'))
  free('mika', 'https://finsmes.com/x', 'mika Raises €6M in Seed Funding', FINSMES.replace('Venture Capital News', 'Venture Capital News Our Customers'))
  free('mika', 'https://finsmes.com/x', 'mika Raises €6M in Seed Funding', `${FINSMES} The company will acquire new customers. FinSMEs 2026.`)
  free('mika', 'https://finsmes.com/x', 'mika Raises €6M', `${FINSMES} mika is using the capital to hire, FinSMEs reports.`)
  free('Acme Foods', 'https://shopify.com/blog/x', 'Blog', 'Acme Foods raised €6M. Its tools, such as customer support software, integrate with Shopify.')
  // a use verb that is not about the brand: the brand comes much later, or after the headline's separator
  free('mika', 'https://finsmes.com/x', 'mika uses AI to raise €6M - FinSMEs', 'mika uses AI to raise €6M Sign in FinSMEs Intelligence. The company raised money.')
  free('mika', 'https://finsmes.com/x', 'mika Raises €6M - FinSMEs', 'mika raised €6M. The company intends to use the funds to grow. FinSMEs covers venture capital.')
  free('Acme Foods', 'https://zapier.com/blog/x', 'Zapier blog', 'Brightloop uses Zapier for its workflows. Acme Foods opened a new plant in Ohio.')
  free('Acme Foods', 'https://zapier.com/blog/x', 'Zapier blog', 'Acme Foods is using more automation. Zapier wrote about the trend.')
})

test('a vendor\'s customer story is still held: every wording main held (the council\'s list)', () => {
  // 1. the headline proper names both, or the title labels itself a customer story
  held('Acme', 'https://zendesk.com/customer/acme', 'How Acme scaled support with Zendesk', 'Read the story.')
  held('Acme', 'https://notion.so/customers/acme', 'Acme cut onboarding time by 40% with Notion', 'Teams are using docs.')
  held('Acme', 'https://vercel.com/customers/acme', 'Why Acme moved to Vercel', 'The team is now shipping daily.')
  held('Orbitly', 'https://acmecrm.com/customers/orbitly', 'Customer story: Orbitly runs on AcmeCRM', 'Orbitly raised a seed round.')
  held('Acme', 'https://stripe.com/customers/acme', 'Acme | Customer story | Stripe', 'The team is now faster.')
  // 2. one sentence: the company uses the brand
  for (const [brandHost, text] of [['zapier.com', 'Brightloop uses Zapier for its sales workflows and saved 20 hours a week.'], ['shopify.com', 'Brightloop switched to Shopify last spring.'], ['shopify.com', 'After a long search Brightloop chose Shopify.'],
    ['twilio.com', 'Brightloop is powered by Twilio.'], ['okta.com', 'Brightloop trusts Okta to secure 10,000 employees.'], ['salesforce.com', 'Brightloop selected Salesforce.'], ['mongodb.com', 'Brightloop migrated to MongoDB Atlas.'],
    ['servicenow.com', 'Brightloop deployed ServiceNow.'], ['slack.com', 'Brightloop rolled out Slack.'], ['hubspot.com', 'Brightloop partnered with HubSpot.'], ['stripe.com', 'Brightloop moved its global payments to Stripe.'],
    ['atlassian.com', 'Brightloop builds faster on Atlassian.'], ['linear.app', 'Brightloop is a Linear customer since 2024.'], ['zapier.com', 'Brightloop became a Zapier customer in 2019 and now uses it daily.'], ['zapier.com', 'Brightloop is now a Zapier customer.'],
    ['zapier.com', 'How Brightloop automated 40 hours a week with Zapier.']] as const) held('Brightloop', `https://${brandHost}/customers/brightloop`, 'Customers', text)
  // 3. one sentence: the brand serves the company
  held('Brightloop', 'https://workday.com/customers/x', 'Customers', 'Workday was chosen by Brightloop.')
  held('Brightloop', 'https://intercom.com/customers/x', 'Customers', 'Intercom helps Brightloop resolve 50% of questions.')
  held('Brightloop', 'https://gong.io/customers/x', 'Customers', 'Gong customer Brightloop grows win rate 20%.')
  // 4. a customer list beside the brand
  held('Salesforce', 'https://linear.app/now/sharing-growth', 'Sharing growth with the people building Linear', 'Linear grew fast. Salesforce and Figma, which both became customers earlier this year.')
})

test('names as they are written: a legal suffix\'s period does not end the sentence; a non-Latin company name is matched', () => {
  held('Acme, Inc.', 'https://zapier.com/customers/acme', 'Customers', 'Acme, Inc. uses Zapier to automate sales.')
  held('Acme Corp', 'https://zapier.com/customers/acme', 'Customers', 'Acme Corp. uses Zapier to automate sales.')
  held('Рога и копыта', 'https://zapier.com/customers/x', 'Customers', 'Рога и копыта uses Zapier for everything.')
})

test('the relationship must be written in ONE sentence, or the list must be beside the brand', () => {
  // the company in one sentence, the brand's customer statement about someone else in another
  free('Acme Foods', 'https://linear.app/now/x', 'Linear news', 'Acme Foods opened a plant. Figma and Ramp became customers of Linear this year.')
  // a customer list that names the company but with the brand nowhere near it
  free('Acme Foods', 'https://linear.app/now/x', 'News', `Linear shipped a release. ${'Many teams read this newsletter every week. '.repeat(6)}Acme Foods and Figma became customers of a local bank.`)
  // the lead's own site is never a counterparty (decided before the page is read)
  free('Zapier', 'https://zapier.com/blog/x', 'Zapier blog', 'Zapier uses Zapier for everything.')
})

test('a short verified passage (the recheck path) is judged by the same rule, without the page title', () => {
  assert.equal(cp('Brightloop', 'https://zapier.com/customers/x', 'Brightloop | Zapier', 'unrelated page text', 'Brightloop uses Zapier for its sales workflows.'), 'source_owner:zapier')
  assert.equal(cp('mika', 'https://finsmes.com/x', 'How mika works with FinSMEs', FINSMES, 'mika, a Berlin, Germany-based provider, raised €6M in Seed funding.'), null, 'the passage decides; the title is not read with it')
})

test('known and kept (as on main): the brand in the headline itself, and a brand that is a common word', () => {
  // Sifted's own list page about the company: the brand is part of the headline
  assert.equal(cp('Acme', 'https://sifted.eu/x', 'Acme joins the Sifted 100 list', 'Founders read it.'), 'source_owner:sifted')
  // "ramp" the word, on ramp.com: not told apart from the brand
  assert.equal(cp('Acme', 'https://ramp.com/blog/x', 'Ramp news', 'Acme is using the funds to ramp up hiring. Ramp news.'), 'source_owner:ramp')
})
