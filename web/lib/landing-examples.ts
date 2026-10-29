// The homepage demo's scenarios: very different businesses and countries, because dazl works for any business,
// anywhere. The slot for real ones: set `real: true` and fill each lead from a saved scan (a working source URL, the
// quoted line exactly as on that page, its date, and why the signal matters). While `real` is false the demo is labelled
// on screen and for screen readers as an illustrative example with made-up companies and people, and no source is linked.
export interface ExampleLead { name: string; title: string; company: string; fit: number; quote: string; source: string; url: string | null; date: string; why: string }
export interface Scenario { id: string; chip: string; site: string; play: string; where: string; leads: ExampleLead[] }
const L = (name: string, title: string, company: string, fit: number, quote: string, source: string, date: string, why: string): ExampleLead => ({ name, title, company, fit, quote, source, url: null, date, why })
export const EXAMPLES: { real: boolean; scenarios: Scenario[] } = {
  real: false,
  scenarios: [
    { id: 'saas-london', chip: 'B2B SaaS · London', site: 'ledgerline.example', play: 'Seed-funded UK startups hiring their first sales rep', where: 'London · funding and hiring news', leads: [
      L('Hannah Okoro', 'Co-founder & CEO', 'Parcelwise', 5, 'Parcelwise raises £2.4M seed to expand across the UK.', 'uktechnews.example', '21 Oct 2026', 'New money and a sales hire coming: they will need a sales process.'),
      L('Tom Ashby', 'Founder', 'Brightdesk', 5, 'We’re hiring our first Account Executive in London.', 'brightdesk.example', '17 Oct 2026', 'A first sales hire is the moment to set up outbound.'),
      L('Priya Shah', 'COO', 'Fernbrook Health', 4, 'Fernbrook Health closes seed round led by Northzone.', 'sifted.example', '9 Oct 2026', 'Post-seed teams buy tools before they scale headcount.'),
    ] },
    { id: 'agency-toronto', chip: 'Marketing agency · Toronto', site: 'northpeak-creative.example', play: 'Toronto companies launching a new brand or product', where: 'Toronto · launches and rebrands', leads: [
      L('Daniel Tremblay', 'Marketing Director', 'Maple & Oak Furniture', 5, 'Maple & Oak opens its first flagship store on Queen West.', 'blogto.example', '19 Oct 2026', 'A flagship opening needs a launch campaign.'),
      L('Aisha Rahman', 'Founder', 'Glow Botanics', 4, 'Glow Botanics launches in 120 Shoppers Drug Mart stores.', 'retail-insider.example', '12 Oct 2026', 'National retail launch, small in-house team.'),
      L('Marc Gagnon', 'VP Growth', 'Tidewater Payments', 4, 'Tidewater Payments unveils new brand ahead of US expansion.', 'betakit.example', '6 Oct 2026', 'A rebrand before expansion is agency work.'),
    ] },
    { id: 'dental-nyc', chip: 'Dental group · New York', site: 'brightsmile-dental.example', play: 'NYC dental practices opening a new location', where: 'New York · expansion and hiring news', leads: [
      L('Maya Lindqvist', 'Founder', 'Northside Ortho', 5, 'We’re opening our second clinic in Park Slope this spring.', 'brooklynpaper.example', '14 Oct 2026', 'A second clinic means a second front desk to book.'),
      L('Omar Haddad', 'Practice owner', 'Kite Family Dental', 5, 'Now hiring two front-desk coordinators.', 'kitefamilydental.example', '9 Oct 2026', 'Hiring for scheduling is the problem you solve.'),
      L('Rosa Delgado', 'Practice manager', 'Astoria Smiles', 4, 'Astoria Smiles adds Saturday hours and a fourth chair.', 'qns.example', '2 Oct 2026', 'More chairs and hours, more appointments to fill.'),
    ] },
    { id: 'cre-gurugram', chip: 'Commercial real estate · Gurugram', site: 'axisspaces.example', play: 'Companies expanding offices in Gurugram and Delhi NCR', where: 'Gurugram · expansion and funding news', leads: [
      L('Rohan Mehta', 'Head of Admin', 'Zentro Logistics', 5, 'Zentro to double its Gurugram headcount to 400 by March.', 'economictimes.example', '20 Oct 2026', 'Doubling headcount means a bigger office.'),
      L('Ananya Iyer', 'CFO', 'Finvest Labs', 4, 'Finvest Labs raises ₹120 crore Series B.', 'inc42.example', '11 Oct 2026', 'Series B teams move to larger offices.'),
      L('Vikram Sethi', 'Facilities Manager', 'Kairo Health', 4, 'Kairo Health opens its NCR operations centre.', 'livemint.example', '4 Oct 2026', 'A new operations centre needs space now.'),
    ] },
    { id: 'logistics-dubai', chip: 'Logistics · Dubai', site: 'gulfroute-freight.example', play: 'UAE retailers and e-commerce brands scaling deliveries', where: 'Dubai · launches and expansion news', leads: [
      L('Sara Al Mansoori', 'Operations Director', 'Desert Bloom Home', 5, 'Desert Bloom Home launches next-day delivery across the UAE.', 'gulfnews.example', '18 Oct 2026', 'Next-day delivery needs a freight partner.'),
      L('Karim Nassar', 'Supply Chain Lead', 'Oudh & Co', 4, 'Oudh & Co opens three new stores in Dubai Mall and Abu Dhabi.', 'khaleejtimes.example', '10 Oct 2026', 'More stores, more stock to move.'),
      L('Leila Haddad', 'Founder', 'FitBox ME', 4, 'FitBox ME expands to Saudi Arabia after a $6M round.', 'wamda.example', '3 Oct 2026', 'Cross-border expansion needs logistics.'),
    ] },
  ],
}
