import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sc from '../lib/connectors/job-board-slug.ts'

// #1122 / #1037: the live prod run of 2026-11-16 (prod 10e3dc3e, job 6b7e54aaf53b67fc7e874115, "Small marketing and creative agencies in
// Toronto, Ontario hiring an SDR") kept one lead, War Room, held for review, with no company website and "No buyer named yet". Its source was
// an aggregator posting whose page links no company site, only the employer's Rippling posting. Shapes below are from that real page.
const SRC = 'https://growthroles.com/jobs/war-room-business-development-representative-torontoremote-toronto-7d65eab6263dde76'
const ATS = 'https://ats.rippling.com/war-room-careers/jobs/3d46c27a-6efa-4505-b2b4-790d52ce4ee7'
const html = (b: string) => `<html><body>${b}</body></html>`
const GROWTHROLES = html(`<a href="/">Jobs</a><a href="/companies/war-room">War Room</a><h1>Business Development Representative - Toronto/Remote</h1>
<p>War Room is looking for a Business Development Representative (BDR) to join our growing team!</p>
<a href="${ATS}">Apply</a><a href="https://ats.rippling.com/other-agency-careers/jobs/1">Other job</a>
<a href="/jobs/citylitics-business-development-representative-toronto-d141a5f3a1d98032">Citylitics</a>
<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Business Development Representative - Toronto/Remote', hiringOrganization: { '@type': 'Organization', name: 'War Room', logo: 'https://growthroles.com/logos/war-room.webp' } })}</script>`)

test('#1122 the real aggregator URL + its ATS link give the employer slug; another employer\'s ATS link on the page is never used', () => {
  const b = sc.jobBoardSlugs('War Room', SRC, GROWTHROLES)
  assert.equal(b.slug, 'war-room-careers')
  assert.deepEqual(b.ats, [ATS])
  assert.deepEqual(sc.slugDomains(b.slug, ['Toronto, Ontario']), ['warroom.com', 'warroom.ca', 'warroominc.com', 'warroomhq.com'])
  // no ATS link: the aggregator's own /jobs/<company>-... path still gives the slug
  assert.equal(sc.jobBoardSlugs('War Room', SRC, '').slug, 'war-room')
  // a page about another company gives nothing for this one
  assert.deepEqual(sc.jobBoardSlugs('Citylitics', SRC, GROWTHROLES), { slug: '', ats: [] })
  assert.deepEqual(sc.slugDomains('ab'), [])
})
