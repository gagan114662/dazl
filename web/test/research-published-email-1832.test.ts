import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

register('./helpers/tsx-loader.mjs', import.meta.url)
const fields = () => import('../app/app/leads/field-provenance.tsx')

const source = 'https://company.example/contact'
const address = 'contact@company.example'
const lead = { company_domain: 'company.example', source_url: 'https://news.example/event', contact: null }

test('#1832 Research wires published email independently of the contact search gate and only keeps display-only actions', () => {
  const client = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const research = client.slice(client.indexOf('data-testid="research-heading"'), client.indexOf('data-testid="monitors"'))
  assert.match(research, /part === 'research' && !l\.quarantined_at && <ResearchPublishedEmail lead=\{l\}/)
  assert.match(research, /part === 'review' \|\| a\.label === 'Keep as research' \|\| a\.label === 'Keep this signal'/)
  assert.match(research, /showAction && <button onClick=\{\(\) => confirmReview/)
  assert.doesNotMatch(research, /approveLead|Draft email/)
})

test('#1832 a stored display-only email on a Research card shows the address and its own source without an action', async () => {
  const { ResearchPublishedEmail } = await fields()
  const html = renderToStaticMarkup(createElement(ResearchPublishedEmail, {
    lead: { ...lead, review_reason: 'trial_budget_reached',
      company_first_published_email: { address, source_url: source, display_only: true } },
  }))
  assert.match(html, /Published work email \(display only\): contact@company\.example/)
  assert.match(html, /href="https:\/\/company\.example\/contact"[^>]*>Email source</)
  assert.doesNotMatch(html, /<button|mailto:|news\.example/)
})

test('#1832 Research will not promote an unsupported address or show an unsafe link', async () => {
  const { ResearchPublishedEmail } = await fields()
  assert.equal(renderToStaticMarkup(createElement(ResearchPublishedEmail, { lead: { ...lead, contact: address } })), '')
  const unsafe = { ...lead, company_first_published_email: { address, source_url: 'javascript:alert(1)', display_only: true as const } }
  assert.equal(renderToStaticMarkup(createElement(ResearchPublishedEmail, { lead: unsafe })), '')
})

test('#1832 a sourced email stays hidden if the Research hold puts the company in doubt', async () => {
  const { ResearchPublishedEmail } = await fields()
  const sourced = { ...lead, name: 'Sample Buyer', source_kind: 'discover',
    enrichments: [{ connector: 'discover', kind: 'email', value: 'sample.buyer@company.example', source_url: source, label: 'published on a public page' }] }
  const render = (review_reason: string) =>
    renderToStaticMarkup(createElement(ResearchPublishedEmail, { lead: { ...sourced, review_reason } }))
  assert.match(render('research_unverified'), /href="https:\/\/company\.example\/contact"/)
  assert.equal(render('location_mismatch'), '')
  const unlabeled = { ...sourced, review_reason: 'research_unverified',
    enrichments: sourced.enrichments.map(row => ({ ...row, label: null })) }
  assert.equal(renderToStaticMarkup(createElement(ResearchPublishedEmail, { lead: unlabeled })), '')
})
