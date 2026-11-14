// #878 (matrix berlin-fintech, 2026-11-14): 4 of 5 funding-news leads were held as "counterparty_signal" - the rule read every news article
// about a company as the publisher's customer story, because the publisher's name sits beside the headline and a customer word ("use",
// "joins", "is now") is somewhere in the first 3,000 characters of any article. The page shapes below are the real pages the scan cited
// (title and opening text as dazl fetched them on 2026-11-14, shortened): finsmes.com, lawdragon.com, startbase.de, heliad.com,
// fintech.garden. Pure function tests: no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { counterpartySignal } from '../lib/scan/counterparty.ts'

const cand = (company: string, source_url: string) => ({ name: '', company, contact: null, signal: '', source_url, score: 80, excerpt: '', event_date: null })
const page = (title: string, text: string) => ({ title, text, retrievedAt: 0 })
const cp = (company: string, url: string, title: string, text: string) => counterpartySignal(cand(company, url) as never, page(title, text) as never, '')

const FINSMES = 'mika Raises €6M in Seed Funding Sign in FinSMEs Intelligence USA UK Germany France Canada India Italy Submit Press Release Sign in Welcome! Log into your account your username your password Forgot your password? Password recovery Recover your password your email Search FinSMEs The Website About Venture Capital News My account Get into your account. Login FinSMEs Intelligence Home Germany mika Raises €6M in Seed Funding By FinSMEs - September 24, 2026 Facebook Twitter WhatsApp Linkedin mika , a Berlin, Germany-based provider of an AI-native financial operating system for SMEs, raised €6M in Seed funding. The round was led by Smedvig Ventures. The company intends to use the funds to expand operations and its development efforts. Led by its founders, mika is now building an AI-native operating system that SMEs are using to run their finances.'
const LAWDRAGON = 'McGuireWoods Bolsters Insurance Recovery Practice | Lawdragon News & Features Lawyer Limelights Consultant Limelights Guides Nominations The Magazine About Shop McGuireWoods Bolsters Insurance Recovery Practice By Lawdragon News | September 8, 2026 | Press Releases , McGuireWoods News McGuireWoods continues the expansion of its nationally ranked Insurance Recovery Practice Group with the arrival of partner Andrew M. Barrios , who brings more than a decade of complex litigation experience. Barrios joins the firm s Chicago office to help lead the growth of the insurance recovery practice in that market.'

test('a news article about a company is not the publisher\'s customer story (real pages: FinSMEs, Lawdragon, startbase, an investor\'s own news page)', () => {
  assert.equal(cp('mika', 'https://finsmes.com/2026/09/mika-raises-e6m-in-seed-funding.html', 'mika Raises €6M in Seed Funding', FINSMES), null)
  assert.equal(cp('finmid', 'https://finsmes.com/2026/10/finmid-raises-e17m-in-series-a-extension-funding.html', 'finmid Raises €17M in Series A Extension Funding', FINSMES.replace(/mika/g, 'finmid')), null)
  assert.equal(cp('McGuireWoods', 'https://lawdragon.com/press-releases/2026-09-08-mcguirewoods-bolsters-insurance-recovery-practice', 'McGuireWoods Bolsters Insurance Recovery Practice | Lawdragon', LAWDRAGON), null)
  assert.equal(cp('mika', 'https://startbase.de/news/mika-erhaelt-6-millionen-euro-fuer-ki-native-buchhaltung', 'mika erhält 6 Millionen Euro für KI-native Buchhaltung | Startbase', 'Startbase News Das Berliner FinTech mika hat sechs Millionen Euro in einer Seed-Finanzierungsrunde eingesammelt. Startbase ist die Plattform für Startups. Jetzt Startbase beitreten. mika is now live in Germany and teams are using it daily.'), null)
  // an investor announcing its portfolio company's round on its own site: the investor is not the company's vendor
  assert.equal(cp('Limetax', 'https://heliad.com/highlights/limetax-raises-eu36m', 'Limetax raises €36m | Heliad', 'Heliad Highlights Limetax raises €36m to build Germany\'s agentic-first accounting and tax group. €6 million in pre-seed equity led by Motive Partners with participation from Activant and Heliad. Limetax is now using the capital to acquire firms.'), null)
})

test('the customer relationship still holds a lead: the company uses the brand, or the brand lists it among its customers', () => {
  // the lead's company, a customer verb, then the brand, in one sentence
  assert.equal(cp('Brightloop', 'https://zapier.com/customers/brightloop', 'Brightloop | Zapier', 'Customer stories. Brightloop uses Zapier for its sales workflows and saved 20 hours a week.'), 'source_owner:zapier')
  assert.equal(cp('Acme Foods', 'https://shopify.com/blog/acme', 'Why Acme Foods switched to Shopify', 'Acme Foods switched to Shopify last spring.'), 'source_owner:shopify')
  assert.equal(cp('Acme Foods', 'https://shopify.com/blog/acme', 'Acme Foods', 'After a long search Acme Foods chose Shopify.'), 'source_owner:shopify')
  // a customer list near the brand that names the lead's company
  assert.equal(cp('Salesforce', 'https://linear.app/now/sharing-growth', 'Sharing growth with the people building Linear', 'Linear grew fast. Salesforce and Figma, which both became customers earlier this year.'), 'source_owner:linear')
})

test('the verb must tie THIS company to the brand: a customer word elsewhere, another company using the brand, or the brand using something else is not it', () => {
  // "use" is about the funds, not the publisher
  assert.equal(cp('mika', 'https://finsmes.com/x', 'mika Raises €6M - FinSMEs', 'mika raised €6M. The company intends to use the funds to grow. FinSMEs covers venture capital.'), null)
  // another company uses the brand; the lead is only mentioned in the next sentence
  assert.equal(cp('Acme Foods', 'https://zapier.com/blog/x', 'Zapier blog', 'Brightloop uses Zapier for its workflows. Acme Foods opened a new plant in Ohio.'), null)
  // the sentence ends between the company and the brand
  assert.equal(cp('Acme Foods', 'https://zapier.com/blog/x', 'Zapier blog', 'Acme Foods is using more automation. Zapier wrote about the trend.'), null)
  // the lead's own site is never a counterparty
  assert.equal(cp('Zapier', 'https://zapier.com/blog/x', 'Zapier blog', 'Zapier uses Zapier for everything.'), null)
})
