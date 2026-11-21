// #1428 (owner decision 2026-11-20): at launch dazl shows one plan, the free beta. The homepage pricing section and the
// /pricing and /plans pages render this same list (app/free-beta-card.tsx), so they cannot drift apart. Each line says
// what the product does today, in plain words.
export const FREE_BETA = {
  name: 'Free beta',
  price: '$0',
  items: [
    'Paste your website: dazl works out who buys from you',
    'Businesses with a dated buying signal, found on their own site, a job board or the news',
    'The quoted line and the source link behind every ready lead',
    'An email drafted from that proof',
    'Sent from your own Gmail',
  ],
} as const
