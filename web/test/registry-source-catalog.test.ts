import assert from 'node:assert/strict'
import test from 'node:test'
import { REGISTRY_SOURCE_CATALOG } from '../lib/sources/registry-source-catalog.ts'
import { AUSTIN_PERMITS, austinPermitsSource, permitQuery } from '../lib/research/sources/socrata-permits.ts'
import { CHUNK, licenceQueries, VANCOUVER_LICENCES, vancouverLicencesSource } from '../lib/research/sources/opendatasoft-licences.ts'
import { researchEngineOn } from '../lib/research/engine.ts'

test('official publisher config has fixed registries and distinct evidence meanings, not enabled sources', () => {
  const entries = Object.values(REGISTRY_SOURCE_CATALOG)
  assert.ok(Object.isFrozen(REGISTRY_SOURCE_CATALOG))
  assert.deepEqual(entries.map(s => [s.country, s.evidence]), [['US', 'permit_issued'], ['CA', 'licence_issued'], ['GB', 'hygiene_rating']])
  for (const source of entries) {
    assert.ok(Object.isFrozen(source))
    for (const link of [...('resource' in source ? [source.resource] : []), ...('recordTable' in source ? [source.recordTable] : [])]) {
      const u = new URL(link)
      assert.equal(u.protocol, 'https:')
      assert.equal(u.username + u.password + u.port + u.search + u.hash, '')
    }
  }
  assert.equal(researchEngineOn({}), false)
  assert.equal(researchEngineOn({ LEAD_ENGINE: 'legacy' }), false)
  assert.equal(researchEngineOn({ LEAD_ENGINE: 'research' }), true)
})

test('existing adapters keep the exact publisher endpoints, field projections and limits', () => {
  const url = new URL(permitQuery(AUSTIN_PERMITS, AUSTIN_PERMITS.categories.roofing, '2026-11-01'))
  assert.equal(url.origin + url.pathname, 'https://data.austintexas.gov/resource/3syk-w9eu.json')
  assert.equal(url.searchParams.get('$limit'), '500')
  assert.equal(url.searchParams.get('$offset'), '0')
  assert.equal(url.searchParams.get('$select'), 'issue_date,contractor_company_name,contractor_full_name,contractor_trade,description,permit_number,permit_location,link')
  assert.equal(VANCOUVER_LICENCES.api, 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences')
  assert.equal(VANCOUVER_LICENCES.explore, 'https://opendata.vancouver.ca/explore/dataset/business-licences/table/')
  assert.deepEqual(Object.keys(REGISTRY_SOURCE_CATALOG.ukFoodHygieneRatings).sort(), ['authority', 'country', 'evidence'])
})

test('catalog entries do not dispatch out of the existing adapter coverage or substitute another source', async () => {
  const base = { tenant: 'fixture', jobId: 'fixture', query: '', offer: 'fixture', windowDays: 30, today: '2026-11-20' }
  let fetches = 0
  const never = async () => { fetches++; throw new Error('unexpected publisher dispatch') }
  for (const [source, where, category] of [
    [austinPermitsSource, 'Vancouver, British Columbia', 'roofing contractors'],
    [austinPermitsSource, 'Austin, Texas', 'restaurants'],
    [vancouverLicencesSource, 'Austin, Texas', 'restaurants'],
    [vancouverLicencesSource, 'Vancouver, British Columbia', 'roofing contractors'],
  ] as const) {
    const scope = { ...base, where, category }
    assert.equal(source.covers(scope), false)
    assert.deepEqual(await source.collect(scope, '2026-10-20', never), { candidates: [], notes: ['not_covered'] })
  }
  assert.equal(fetches, 0)
  assert.notEqual(REGISTRY_SOURCE_CATALOG.ukFoodHygieneRatings.evidence, REGISTRY_SOURCE_CATALOG.vancouverBusinessLicences.evidence)
})

test('built-in descriptors and operational constants cannot be changed via exported configuration or compatibility views', async () => {
  const { austinIssuedPermits: a, vancouverBusinessLicences: v } = REGISTRY_SOURCE_CATALOG
  assert.equal(Reflect.set(a.jurisdiction, 'city', 'Other'), false)
  assert.equal(Reflect.set(a.jurisdiction.where, 'source', '.*'), false)
  assert.equal(Reflect.set(a.categories.roofing.exclude, 'source', '(?:)'), false)
  assert.equal(Reflect.set(a.fields, 'date', 'other'), false)
  assert.equal(Reflect.set(a.limits, 'maxPages', 99), false)
  assert.equal(Reflect.set(v.categories.restaurants.types, '0', 'Other'), false)
  assert.equal(Reflect.set(v.fields, 'year', 'other'), false)
  assert.equal(Reflect.set(v.limits, 'termsPerRequest', 100), false)
  assert.equal(CHUNK, 25)
  assert.equal(a.limits.pageRows, 500)
  assert.equal(a.limits.maxPages, 4)
  assert.equal(v.limits.recordLimit, 5)
  const initialPermitGeo = AUSTIN_PERMITS.where
  const initialLicenceTypes = VANCOUVER_LICENCES.categories.restaurants.types
  try {
    AUSTIN_PERMITS.where = /.*/
    VANCOUVER_LICENCES.categories.restaurants.types = ['Other']
    const caseStub = {tenant: 'fixture', jobId: 'fixture', query: '', offer:'fixture',windowDays:30,today:'2026-11-20'}
    assert.equal(austinPermitsSource.covers({...caseStub, where:'Wrong Place', category:'roofing contractors'}), false)
    assert.deepEqual(v.categories.restaurants.types, ['Restaurant'])
    let licenceReads = 0
    await vancouverLicencesSource.collect({ ...caseStub, where: 'Vancouver, British Columbia', category: 'restaurants' }, '2026-10-20', async target => {
      licenceReads++
      assert.match(new URL(target).searchParams.get('where') ?? '', /businesstype="Restaurant"/)
      return { status: 200, body: '[]' }
    })
    assert.equal(licenceReads, 1)
  } finally {
    AUSTIN_PERMITS.where = initialPermitGeo
    VANCOUVER_LICENCES.categories.restaurants.types = initialLicenceTypes
  }

  const l = new URL(licenceQueries(VANCOUVER_LICENCES, 'restaurants', '2026-10-20', ['26']).window)
  assert.equal(l.searchParams.get('select'), 'folderyear,licencenumber,businessname,businesstradename,status,issueddate,unit,house,street,localarea,businesssubtype')
  assert.equal(l.searchParams.get('where'), '(businesstype="Restaurant") and (folderyear="26") and status="Issued" and issueddate >= date\'2026-10-20\'')
})

test('existing permit four-page ceiling and ordered offsets survive descriptor extraction', async () => {
  const offsets: string[] = []
  const row = { issue_date: '2026-11-01', contractor_company_name:'Example Roofing LLC', contractor_trade:'General Contractor',
    description:'Express: Re-roof', permit_number:'fixture', permit_location:'fixture', link:{url:'https://example.test/permit'} }
  const scope = { tenant:'fixture', jobId:'fixture', query:'', offer:'fixture', where:'Austin, Texas', category:'roofing contractors',
    windowDays:30, today:'2026-11-20' }
  const result = await austinPermitsSource.collect(scope, '2026-10-20', async target => {
    const p = new URL(target).searchParams
    assert.equal(p.get('$limit'),'500')
    offsets.push(p.get('$offset')!)
    return { status:200, body:JSON.stringify(Array(500).fill(row)) }
  })
  assert.deepEqual(offsets,['0','500','1000','1500'])
  assert.deepEqual(result.notes,['row_cap_reached'])
})
