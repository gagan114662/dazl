import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

register('./helpers/tsx-loader.mjs', import.meta.url)

const website = 'company.example'
const proof = 'https://www.company.example/about'
const crawl = {
  connector: 'sitecrawl',
  kind: 'domain',
  value: website,
  label: 'domain basis: the cited page is on this domain; homepage names the company',
  source_url: proof,
}

async function renderWebsite(row: typeof crawl) {
  const { WebsiteProvenance } = await import('../app/app/leads/field-provenance.tsx')
  return renderToStaticMarkup(createElement(WebsiteProvenance, {
    lead: { company_domain: website, enrichments: [row] },
  }))
}

test('#1877 a saved company website shows its historical first-party crawl source', async () => {
  const html = await renderWebsite(crawl)
  assert.match(html, /href="https:\/\/www\.company\.example\/about"[^>]*>Website source<\/a>/)
  assert.doesNotMatch(html, /Website source unavailable|verified/i)
})

test('#1877 a legacy row cannot cite an unrelated site or a different company domain', async () => {
  for (const row of [
    { ...crawl, source_url: 'https://unrelated.example/about' },
    { ...crawl, value: 'unrelated.example' },
  ]) {
    const html = await renderWebsite(row)
    assert.match(html, /Website source unavailable/)
    assert.doesNotMatch(html, /www\.company\.example\/about|unrelated\.example/)
  }
})

test('#1877 a discovery card can cite its recorded same-site public contact page', async () => {
  const { WebsiteProvenance } = await import('../app/app/leads/field-provenance.tsx')
  const html = renderToStaticMarkup(createElement(WebsiteProvenance, {
    lead: {
      company_domain: website,
      company_first_published_email: { address: 'person@company.example', source_url: proof, display_only: true },
    },
  }))
  assert.match(html, /href="https:\/\/www\.company\.example\/about"[^>]*>Website source<\/a>/)
  assert.doesNotMatch(html, /Website source unavailable|verified/i)
})

test('#1877 a discovery enrichment on a matching subdomain can cite the website', async () => {
  const html = await renderWebsite({
    ...crawl, connector: 'discover', kind: 'person', value: 'A Named Contact',
    source_url: 'https://team.company.example/about',
  })
  assert.match(html, /href="https:\/\/team\.company\.example\/about"[^>]*>Website source<\/a>/)
})

test('#1877 contact proof on a lookalike or unrelated site cannot cite the website', async () => {
  for (const source_url of ['https://company.example.other.example/about', 'https://unrelated.example/about', 'https://name@company.example/about']) {
    const html = await renderWebsite({ ...crawl, connector: 'discover', kind: 'email', value: 'person@company.example', source_url })
    assert.match(html, /Website source unavailable/)
  }
})
