// A static ISO 3166-1 country table (no network): alpha-2, alpha-3, the English short name and the common aliases / native or short forms. Used only to decide whether an address or place a
// record states names a country OTHER than the lead's ("57 W 57th St, New York, NY, Zimbabwe"). Display and identity decisions never rest on it alone.
//   - Two-letter codes are NOT looked up as codes (CA, IN, DE, GA, AL, ... are US states); only "US", "UK" and "GB" are accepted as written aliases.
//   - A US state name / abbreviation, "District of Columbia" and a "New ..." US state name always resolve to the United States, never to a country of the same spelling
//     ("Georgia", "New Jersey" vs Jersey, "New Mexico" vs Mexico).
//   - "Georgia" alone is the US state (a Georgia address reads as Atlanta, not Tbilisi): the country needs "Republic of Georgia" / "Sakartvelo". "Jersey" is the Channel Islands only when it is not part of "New Jersey".
//   - A name that is also a common US place or English word (Lebanon, Peru, Panama, Mexico, Chad, Jordan ...) counts only as the LAST segment of the text (where an address puts its country).
// Format per line: A2|A3|Name|alias;alias;...
const RAW = `
AF|AFG|Afghanistan|
AX|ALA|Aland Islands|Åland;Aland
AL|ALB|Albania|
DZ|DZA|Algeria|
AS|ASM|American Samoa|
AD|AND|Andorra|
AO|AGO|Angola|
AI|AIA|Anguilla|
AQ|ATA|Antarctica|
AG|ATG|Antigua and Barbuda|Antigua;Barbuda
AR|ARG|Argentina|
AM|ARM|Armenia|
AW|ABW|Aruba|
AU|AUS|Australia|
AT|AUT|Austria|Osterreich
AZ|AZE|Azerbaijan|
BS|BHS|Bahamas|The Bahamas
BH|BHR|Bahrain|
BD|BGD|Bangladesh|
BB|BRB|Barbados|
BY|BLR|Belarus|Byelorussia
BE|BEL|Belgium|Belgique;Belgie
BZ|BLZ|Belize|
BJ|BEN|Benin|
BM|BMU|Bermuda|
BT|BTN|Bhutan|
BO|BOL|Bolivia|Plurinational State of Bolivia
BQ|BES|Bonaire, Sint Eustatius and Saba|Bonaire;Sint Eustatius;Saba
BA|BIH|Bosnia and Herzegovina|Bosnia;Herzegovina
BW|BWA|Botswana|
BV|BVT|Bouvet Island|
BR|BRA|Brazil|Brasil
IO|IOT|British Indian Ocean Territory|
BN|BRN|Brunei|Brunei Darussalam
BG|BGR|Bulgaria|
BF|BFA|Burkina Faso|
BI|BDI|Burundi|
CV|CPV|Cabo Verde|Cape Verde
KH|KHM|Cambodia|
CM|CMR|Cameroon|
CA|CAN|Canada|
KY|CYM|Cayman Islands|Cayman
CF|CAF|Central African Republic|
TD|TCD|Chad|
CL|CHL|Chile|
CN|CHN|China|People's Republic of China;PRC;Mainland China
CX|CXR|Christmas Island|
CC|CCK|Cocos Islands|Cocos (Keeling) Islands;Keeling Islands
CO|COL|Colombia|
KM|COM|Comoros|
CG|COG|Congo|Republic of the Congo;Congo-Brazzaville
CD|COD|Democratic Republic of the Congo|DR Congo;DRC;Congo-Kinshasa;Congo, Democratic Republic
CK|COK|Cook Islands|
CR|CRI|Costa Rica|
CI|CIV|Cote d'Ivoire|Ivory Coast;Côte d'Ivoire
HR|HRV|Croatia|Hrvatska
CU|CUB|Cuba|
CW|CUW|Curacao|Curaçao
CY|CYP|Cyprus|
CZ|CZE|Czechia|Czech Republic
DK|DNK|Denmark|Danmark
DJ|DJI|Djibouti|
DM|DMA|Dominica|
DO|DOM|Dominican Republic|
EC|ECU|Ecuador|
EG|EGY|Egypt|
SV|SLV|El Salvador|
GQ|GNQ|Equatorial Guinea|
ER|ERI|Eritrea|
EE|EST|Estonia|
SZ|SWZ|Eswatini|Swaziland
ET|ETH|Ethiopia|
FK|FLK|Falkland Islands|Malvinas;Falklands
FO|FRO|Faroe Islands|Faroes
FJ|FJI|Fiji|
FI|FIN|Finland|Suomi
FR|FRA|France|
GF|GUF|French Guiana|
PF|PYF|French Polynesia|Tahiti
TF|ATF|French Southern Territories|
GA|GAB|Gabon|
GM|GMB|Gambia|The Gambia
GE|GEO|Republic of Georgia|Sakartvelo;Georgia (country)
DE|DEU|Germany|Deutschland;Federal Republic of Germany
GH|GHA|Ghana|
GI|GIB|Gibraltar|
GR|GRC|Greece|Hellas
GL|GRL|Greenland|
GD|GRD|Grenada|
GP|GLP|Guadeloupe|
GU|GUM|Guam|
GT|GTM|Guatemala|
GG|GGY|Guernsey|
GN|GIN|Guinea|
GW|GNB|Guinea-Bissau|Guinea Bissau
GY|GUY|Guyana|
HT|HTI|Haiti|
HM|HMD|Heard Island and McDonald Islands|
VA|VAT|Holy See|Vatican City;Vatican
HN|HND|Honduras|
HK|HKG|Hong Kong|Hong Kong SAR
HU|HUN|Hungary|Magyarorszag
IS|ISL|Iceland|
IN|IND|India|Bharat
ID|IDN|Indonesia|
IR|IRN|Iran|Islamic Republic of Iran
IQ|IRQ|Iraq|
IE|IRL|Ireland|Republic of Ireland;Eire
IM|IMN|Isle of Man|
IL|ISR|Israel|
IT|ITA|Italy|Italia
JM|JAM|Jamaica|
JP|JPN|Japan|Nippon
JE|JEY|Jersey|Bailiwick of Jersey
JO|JOR|Jordan|
KZ|KAZ|Kazakhstan|
KE|KEN|Kenya|
KI|KIR|Kiribati|
KP|PRK|North Korea|Democratic People's Republic of Korea;DPRK
KR|KOR|South Korea|Korea;Republic of Korea;Korea, Republic of
KW|KWT|Kuwait|
KG|KGZ|Kyrgyzstan|Kyrgyz Republic
LA|LAO|Laos|Lao People's Democratic Republic
LV|LVA|Latvia|
LB|LBN|Lebanon|Republic of Lebanon;Liban
LS|LSO|Lesotho|
LR|LBR|Liberia|
LY|LBY|Libya|
LI|LIE|Liechtenstein|
LT|LTU|Lithuania|
LU|LUX|Luxembourg|
MO|MAC|Macao|Macau
MG|MDG|Madagascar|
MW|MWI|Malawi|
MY|MYS|Malaysia|
MV|MDV|Maldives|
ML|MLI|Mali|
MT|MLT|Malta|
MH|MHL|Marshall Islands|
MQ|MTQ|Martinique|
MR|MRT|Mauritania|
MU|MUS|Mauritius|
YT|MYT|Mayotte|
MX|MEX|Mexico|Estados Unidos Mexicanos
FM|FSM|Micronesia|Federated States of Micronesia
MD|MDA|Moldova|Republic of Moldova
MC|MCO|Monaco|
MN|MNG|Mongolia|
ME|MNE|Montenegro|
MS|MSR|Montserrat|
MA|MAR|Morocco|
MZ|MOZ|Mozambique|
MM|MMR|Myanmar|Burma
NA|NAM|Namibia|
NR|NRU|Nauru|
NP|NPL|Nepal|
NL|NLD|Netherlands|The Netherlands;Holland
NC|NCL|New Caledonia|
NZ|NZL|New Zealand|Aotearoa
NI|NIC|Nicaragua|
NE|NER|Niger|
NG|NGA|Nigeria|
NU|NIU|Niue|
NF|NFK|Norfolk Island|
MK|MKD|North Macedonia|Macedonia
MP|MNP|Northern Mariana Islands|
NO|NOR|Norway|Norge
OM|OMN|Oman|
PK|PAK|Pakistan|
PW|PLW|Palau|
PS|PSE|Palestine|State of Palestine;Palestinian Territories;West Bank;Gaza
PA|PAN|Panama|Republic of Panama
PG|PNG|Papua New Guinea|
PY|PRY|Paraguay|
PE|PER|Peru|Republic of Peru
PH|PHL|Philippines|The Philippines
PN|PCN|Pitcairn|Pitcairn Islands
PL|POL|Poland|Polska
PT|PRT|Portugal|
PR|PRI|Puerto Rico|
QA|QAT|Qatar|
RE|REU|Reunion|Réunion
RO|ROU|Romania|
RU|RUS|Russia|Russian Federation
RW|RWA|Rwanda|
BL|BLM|Saint Barthelemy|Saint-Barthelemy;St Barthelemy
SH|SHN|Saint Helena|St Helena
KN|KNA|Saint Kitts and Nevis|St Kitts and Nevis;Saint Kitts;St Kitts
LC|LCA|Saint Lucia|St Lucia
MF|MAF|Saint Martin|St Martin
PM|SPM|Saint Pierre and Miquelon|
VC|VCT|Saint Vincent and the Grenadines|St Vincent
WS|WSM|Samoa|
SM|SMR|San Marino|
ST|STP|Sao Tome and Principe|São Tomé and Príncipe
SA|SAU|Saudi Arabia|KSA
SN|SEN|Senegal|
RS|SRB|Serbia|
SC|SYC|Seychelles|
SL|SLE|Sierra Leone|
SG|SGP|Singapore|
SX|SXM|Sint Maarten|
SK|SVK|Slovakia|Slovak Republic
SI|SVN|Slovenia|
SB|SLB|Solomon Islands|
SO|SOM|Somalia|
ZA|ZAF|South Africa|RSA
GS|SGS|South Georgia and the South Sandwich Islands|
SS|SSD|South Sudan|
ES|ESP|Spain|Espana;España
LK|LKA|Sri Lanka|
SD|SDN|Sudan|
SR|SUR|Suriname|
SJ|SJM|Svalbard and Jan Mayen|
SE|SWE|Sweden|Sverige
CH|CHE|Switzerland|Schweiz;Suisse;Svizzera
SY|SYR|Syria|Syrian Arab Republic
TW|TWN|Taiwan|Republic of China
TJ|TJK|Tajikistan|
TZ|TZA|Tanzania|United Republic of Tanzania
TH|THA|Thailand|
TL|TLS|Timor-Leste|East Timor
TG|TGO|Togo|
TK|TKL|Tokelau|
TO|TON|Tonga|
TT|TTO|Trinidad and Tobago|Trinidad;Tobago
TN|TUN|Tunisia|
TR|TUR|Turkey|Turkiye;Türkiye
TM|TKM|Turkmenistan|
TC|TCA|Turks and Caicos Islands|Turks and Caicos
TV|TUV|Tuvalu|
UG|UGA|Uganda|
UA|UKR|Ukraine|
AE|ARE|United Arab Emirates|UAE;Emirates
GB|GBR|United Kingdom|UK;U.K.;GB;Great Britain;Britain;England;Scotland;Wales;Northern Ireland;United Kingdom of Great Britain and Northern Ireland
US|USA|United States|US;U.S.;U.S.A.;United States of America;America;America (USA)
UM|UMI|United States Minor Outlying Islands|
UY|URY|Uruguay|
UZ|UZB|Uzbekistan|
VU|VUT|Vanuatu|
VE|VEN|Venezuela|Bolivarian Republic of Venezuela
VN|VNM|Vietnam|Viet Nam
VG|VGB|British Virgin Islands|Virgin Islands, British
VI|VIR|US Virgin Islands|U.S. Virgin Islands;Virgin Islands, U.S.
WF|WLF|Wallis and Futuna|
EH|ESH|Western Sahara|
YE|YEM|Yemen|
ZM|ZMB|Zambia|
ZW|ZWE|Zimbabwe|
`
// US territories are not "foreign" to a US lead only by spelling; they resolve to their own codes (Puerto Rico, Guam ...) and therefore refuse a New York / US-state lead like any other country.

import { US_STATES } from './place-agreement.ts'

const strip = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
const BY_NAME = new Map<string, string>()   // normalised name / alias -> alpha-2
const ALPHA3 = new Map<string, string>()    // upper-case alpha-3 -> alpha-2
for (const line of RAW.split('\n')) {
  if (!line.trim()) continue
  const [a2, a3, name, aliases] = line.split('|')
  for (const n of [name, ...(aliases ?? '').split(';')].map(x => x.trim()).filter(Boolean)) { const f = strip(n); if (f && !BY_NAME.has(f)) BY_NAME.set(f, a2) }
  ALPHA3.set(a3, a2)
}
// Alpha-3 codes that are ordinary words (and, are, can, com ...): never read as a code.
const ALPHA3_WORDS = new Set(['AND', 'ARE', 'CAN', 'COM', 'MAR', 'PER', 'NOR', 'SUR', 'TON', 'MAC', 'LAO', 'ALA', 'GIN', 'DOM', 'FIN', 'ISL', 'NIC', 'PAN', 'REU', 'SOM', 'TUN', 'MAL', 'ATA', 'BEN', 'GUM', 'GUY', 'IRL', 'LIE', 'MON', 'OMN', 'PLW', 'POL', 'ROU', 'SEN', 'SYR', 'TOG', 'UGA', 'YEM'])
// Names that are also US places or English words: only counted as the LAST segment of the text.
const LAST_ONLY = new Set(['lebanon', 'peru', 'panama', 'mexico', 'china', 'cuba', 'jordan', 'chad', 'niger', 'guinea', 'turkey', 'poland', 'italy', 'sweden', 'norway', 'denmark', 'holland', 'malta', 'mali', 'togo', 'oman', 'samoa', 'tonga', 'nauru', 'niue', 'palau', 'macau', 'macao', 'jersey', 'india', 'cyprus', 'israel', 'monaco', 'bermuda', 'jamaica', 'cuba', 'kenya', 'gambia', 'ghana', 'angola', 'albania', 'austria', 'belgium', 'iran', 'iraq', 'laos', 'libya', 'qatar', 'yemen'])
const STATE_FORMS = new Set<string>([...Object.values(US_STATES), ...Object.keys(US_STATES).map(k => k.toLowerCase()), 'district of columbia', 'washington dc', 'dc'])
const US_STATE_NAME = /^(?:new (?:york|jersey|mexico|hampshire)|north (?:carolina|dakota)|south (?:carolina|dakota)|west virginia|rhode island)$/

const trimPostal = (seg: string) => strip(seg).replace(/^(?:\d[\d -]*\s+)/, '').replace(/\s+\d[\d -]*$/, '').replace(/\s+[a-z]\d[a-z] ?\d[a-z]\d$/, '').trim()

// One segment -> its ISO alpha-2, or null. `last`: the segment is the final one of the text (where an address writes its country).
export function resolveSegment(segment: string, last = false): string | null {
  const s = trimPostal(segment)
  if (!s) return null
  if (STATE_FORMS.has(s) || US_STATE_NAME.test(s)) return null   // a US state / DC is never a foreign country ("Georgia", "New Jersey", "New Mexico")
  const raw = segment.trim().replace(/[.\s]+$/g, '')
  if (/^[A-Z]{3}$/.test(raw) && ALPHA3.has(raw) && !ALPHA3_WORDS.has(raw)) return ALPHA3.get(raw)!
  const code = BY_NAME.get(s) ?? BY_NAME.get(s.replace(/^the /, ''))
  if (!code) return null
  if (LAST_ONLY.has(s) && !last) return null
  return code
}
// Every country the text states: each comma segment, plus (for the long unambiguous names) a whole-word scan inside a segment ("Harare Zimbabwe").
export function countriesIn(text: string): string[] {
  const found = new Set<string>()
  const segs = text.split(',').map(x => x.trim()).filter(Boolean)
  segs.forEach((seg, i) => {
    const c = resolveSegment(seg, i === segs.length - 1); if (c) { found.add(c); return }   // the whole segment is a country ("Northern Ireland" is the UK, not Ireland): no tail scan
    const w = strip(seg).split(' ')
    // "New York NY Zimbabwe" written without commas: the last 1-3 words of a segment
    for (let n = 1; n <= 3 && n < w.length; n++) {
      const tail = w.slice(-n).join(' '), c2 = BY_NAME.get(tail)
      if (c2 && !STATE_FORMS.has(tail) && !US_STATE_NAME.test(w.slice(-2).join(' ')) && !(LAST_ONLY.has(tail) && i !== segs.length - 1)) found.add(c2)
    }
  })
  return [...found]
}
export const COUNTRY_COUNT = new Set([...BY_NAME.values()]).size

// True when a comma segment of a place is a country or a region (a US state / DC, a two-letter state code, "England"): the parts of "East Kensington, London, UK" that are NOT a city or neighbourhood.
export function isCountryOrRegion(segment: string): boolean {
  const s = trimPostal(segment)
  if (!s) return false
  return STATE_FORMS.has(s) || US_STATE_NAME.test(s) || resolveSegment(segment, true) !== null || regionOf(segment) !== null   // regions: US states, Canadian provinces, UK constituents
}

// ---- structured country / region fields (schema.org PostalAddress.addressCountry / addressRegion) ----
const A2 = new Set<string>([...BY_NAME.values()])
// In a country FIELD a two-letter value is an ISO code ("GB", "CA" = Canada, "US"): unambiguous there, unlike in free text where CA / IN / DE are US states.
export function countryFromField(v: unknown): string | null {
  const raw = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string' ? (v as { name: string }).name : ''
  const t = raw.trim()
  if (!t) return null
  if (/^[A-Za-z]{2}$/.test(t) && A2.has(t.toUpperCase())) return t.toUpperCase()
  if (/^[A-Za-z]{3}$/.test(t) && ALPHA3.has(t.toUpperCase())) return ALPHA3.get(t.toUpperCase())!
  return resolveSegment(t, true)
}
const CA_PROV: Record<string, string> = { on: 'on', ontario: 'on', qc: 'qc', quebec: 'qc', bc: 'bc', 'british columbia': 'bc', ab: 'ab', alberta: 'ab', mb: 'mb', manitoba: 'mb', sk: 'sk', saskatchewan: 'sk', ns: 'ns', 'nova scotia': 'ns', nb: 'nb', 'new brunswick': 'nb', nl: 'nl', 'newfoundland and labrador': 'nl', pe: 'pe', 'prince edward island': 'pe', yt: 'yt', nt: 'nt', nu: 'nu' }
const UK_REGION: Record<string, string> = { england: 'eng', scotland: 'sct', wales: 'wls', 'northern ireland': 'nir' }
// A region a comma segment names: a US state (name or code), a Canadian province (name or code), or a UK constituent country -> a canonical id ("US-ny", "CA-on", "GB-eng"), else null.
export function regionOf(segment: string): string | null {
  const s = trimPostal(segment)
  if (!s) return null
  for (const [ab, name] of Object.entries(US_STATES)) if (s === name || s === ab.toLowerCase()) return `US-${ab.toLowerCase()}`
  if (s === 'district of columbia' || s === 'dc') return 'US-dc'
  if (CA_PROV[s]) return `CA-${CA_PROV[s]}`
  if (UK_REGION[s]) return `GB-${UK_REGION[s]}`
  return null
}
export const regionsIn = (text: string): string[] => [...new Set(text.split(',').map(regionOf).filter((x): x is string => !!x))]
// A region implies its country: Ontario is Canada, New York is the United States, Scotland is the United Kingdom.
export const countryOfRegion = (r: string): string => (r.startsWith('CA-') ? 'CA' : r.startsWith('GB-') ? 'GB' : 'US')
