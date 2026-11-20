// Reviewed publisher facts only. A listing in this static catalog does not enable
// a collector, add a play, verify a lead, or prove buying intent. These are optional
// sources with specific coverage; unsupported scope never inherits a default.
interface PublisherDataset {
  country: 'US' | 'CA' | 'GB'
  authority: string
  evidence: 'permit_issued' | 'licence_issued' | 'hygiene_rating'
}
// Only plain data leaves this module. Freeze every nested object/array; RegExp objects
// are deliberately not shared (even a frozen RegExp can have mutable internal state).
function freeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child)
  return Object.freeze(value)
}
function publisher<T extends PublisherDataset>(entry: T): Readonly<T> {
  return freeze(entry)
}
const pattern = (re: RegExp) => ({ source: re.source, flags: re.flags })
export const registryPattern = ({source, flags}: Readonly<{source: string; flags: string}>): RegExp => new RegExp(source, flags)

export const REGISTRY_SOURCE_CATALOG = Object.freeze({
  austinIssuedPermits: publisher({
    country: 'US',
    authority: 'City of Austin, Texas',
    resource: 'https://data.austintexas.gov/resource/3syk-w9eu.json',
    evidence: 'permit_issued',
    jurisdiction: { id: 'austin', city: 'Austin', region: 'TX', where: pattern(/^ austin (?:tx|texas)(?: usa?| united states)? $/) },
    fields: { date: 'issue_date', company: 'contractor_company_name', person: 'contractor_full_name', trade: 'contractor_trade', description: 'description', number: 'permit_number', location: 'permit_location', link: 'link' },
    generalTrade: 'General Contractor',
    limits: { pageRows: 500, maxPages: 4 },
    categories: {
      roofing: {
        words: pattern(/ roof(?:er|ers|ing)? /),
        eventKind: 'roofing_permits', noun: 'roofing permit', label: 'Roofing contractors', serverLike: 'ROOF',
        primary: pattern(/^\W*(?:express\s*[:\-]?\s*)?(?:residential\s+|commercial\s+)?(?:re-?roof|roof(?:ing)?\s+(?:replace|repair|over)|new\s+roof|tear[- ]off)/i),
        companyName: pattern(/\broof/i),
        exclude: pattern(/\b(?:solar|photovoltaic|pv)\b|\d+(?:\.\d+)?\s*kw\b/i),
      },
    },
  }),
  vancouverBusinessLicences: publisher({
    country: 'CA',
    authority: 'City of Vancouver, British Columbia',
    resource: 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/business-licences',
    recordTable: 'https://opendata.vancouver.ca/explore/dataset/business-licences/table/',
    evidence: 'licence_issued',
    jurisdiction: { id: 'vancouver', city: 'Vancouver', region: 'BC', where: pattern(/^ vancouver (?:bc|british columbia)(?: canada)? $/), timeZone: 'America/Vancouver' },
    // The first 11 values are the existing export projection in its exact order.
    fields: { year: 'folderyear', number: 'licencenumber', legalName: 'businessname', tradeName: 'businesstradename', status: 'status', issued: 'issueddate', unit: 'unit', house: 'house', street: 'street', area: 'localarea', subtype: 'businesssubtype' },
    typeField: 'businesstype',
    issuedStatus: 'Issued',
    limits: { termsPerRequest: 25, recordLimit: 5 },
    categories: { restaurants: { words: pattern(/ restaurants? /), types: ['Restaurant'], noun: 'restaurant', label: 'Restaurants / food service' } },
  }),
  ukFoodHygieneRatings: publisher({
    country: 'GB',
    authority: 'Food Standards Agency scheme (local authorities)',
    // A rating/inspection record is not a permit, licence, or opening.
    evidence: 'hygiene_rating',
  }),
} as const)
