import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

register('./helpers/tsx-loader.mjs', import.meta.url)

const address = 'office@company.example'
const signal = 'https://news.example/event'
const contactPage = 'https://company.example/contact'
const lead = { company_domain: 'company.example', contact: address, source_url: signal }

async function renderEmail(fields: {
  evidence_excerpt?: string
  contact_context?: { excerpt: string; source_url: string }
}) {
  const { PublishedEmailProvenance } = await import('../app/app/leads/field-provenance.tsx')
  return renderToStaticMarkup(createElement(PublishedEmailProvenance, { lead: { ...lead, ...fields } }))
}

test('#1401 a saved signal excerpt that prints the exact address links to its page', async () => {
  const html = await renderEmail({ evidence_excerpt: 'Business inquiries: OFFICE@COMPANY.EXAMPLE.' })
  assert.match(html, /office@company\.example/)
  assert.match(html, /href="https:\/\/news\.example\/event"/)
})

test('#1401 the specific contact citation wins when both saved pages print the address', async () => {
  const html = await renderEmail({
    evidence_excerpt: `Contact ${address}`,
    contact_context: { excerpt: `Business inquiries go to ${address}.`, source_url: contactPage },
  })
  assert.match(html, /href="https:\/\/company\.example\/contact"/)
  assert.doesNotMatch(html, /news\.example/)
})

test('#1401 another address with a matching suffix does not enable a source link', async () => {
  const html = await renderEmail({ evidence_excerpt: 'Business inquiries: backoffice@company.example.' })
  assert.match(html, /Email source unavailable/)
  assert.doesNotMatch(html, /href=/)
})
