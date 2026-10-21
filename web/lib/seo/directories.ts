// Curated submission directories for the SEO page. Every entry was verified live (HTTP 200 or a
// real rendered page) on 2026-10-21; dead ones (launched.io, saasworthy submit path, Apple
// Business Connect's old URL) were dropped, and URLs point at the exact page that verified -
// a submission page where one exists, the site root otherwise. Listing on a directory is always
// a manual, one-click-open-then-submit action: dazl never submits on the user's behalf.
export type Directory = { name: string; url: string; category: 'Launch' | 'Software review' | 'AI tools' | 'Business & local'; note: string }

export const DIRECTORIES: Directory[] = [
  // Launch & startup
  { name: 'Product Hunt', url: 'https://www.producthunt.com/posts/new', category: 'Launch', note: 'Launch-day visibility; needs an account.' },
  { name: 'BetaList', url: 'https://betalist.com/submit', category: 'Launch', note: 'Pre-launch and early-stage startups.' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com/submit', category: 'Launch', note: 'Show HN works best with a real story, not an ad.' },
  { name: 'AlternativeTo', url: 'https://alternativeto.net', category: 'Launch', note: 'List your product as an alternative to known tools.' },
  { name: 'Indie Hackers', url: 'https://indiehackers.com', category: 'Launch', note: 'Community; share the product and its numbers.' },
  { name: 'r/SideProject', url: 'https://www.reddit.com/r/SideProject/', category: 'Launch', note: 'Reddit community for side projects.' },
  { name: 'StartupBase', url: 'https://startupbase.io/submit', category: 'Launch', note: 'Free startup directory submission.' },
  { name: 'SideProjectors', url: 'https://www.sideprojectors.com', category: 'Launch', note: 'Show off or sell a side project.' },
  { name: 'KillerStartups', url: 'https://www.killerstartups.com', category: 'Launch', note: 'Startup directory since 2007.' },
  { name: 'Wellfound', url: 'https://wellfound.com', category: 'Launch', note: 'Startup profile, also reaches candidates and investors.' },
  { name: 'F6S', url: 'https://www.f6s.com', category: 'Launch', note: 'Founder profiles, programs and deals.' },
  { name: 'EU-Startups Database', url: 'https://eu-startups.com/directory/', category: 'Launch', note: 'European startup database.' },
  { name: 'Startup Ranking', url: 'https://www.startupranking.com', category: 'Launch', note: 'Global startup ranking and listing.' },
  { name: 'Startup Buffer', url: 'https://startupbuffer.com', category: 'Launch', note: 'Startup directory by market and location.' },
  { name: 'Webwiki', url: 'https://www.webwiki.com', category: 'Launch', note: 'Website directory and reviews.' },
  { name: 'Crunchbase', url: 'https://www.crunchbase.com', category: 'Launch', note: 'Company profile used by investors and journalists.' },
  // Software review platforms
  { name: 'G2', url: 'https://www.g2.com', category: 'Software review', note: 'The big B2B software review platform.' },
  { name: 'Capterra', url: 'https://www.capterra.com', category: 'Software review', note: 'Gartner-owned software reviews.' },
  { name: 'GetApp', url: 'https://www.getapp.com', category: 'Software review', note: 'Business software comparisons.' },
  { name: 'Software Advice', url: 'https://www.softwareadvice.com', category: 'Software review', note: 'Reviews plus advisor calls.' },
  { name: 'TrustRadius', url: 'https://www.trustradius.com', category: 'Software review', note: 'In-depth B2B reviews.' },
  { name: 'SourceForge', url: 'https://www.sourceforge.net', category: 'Software review', note: 'B2B software listing, not just open source.' },
  { name: 'StackShare', url: 'https://stackshare.io', category: 'Software review', note: 'List the tool so teams can add it to their stacks.' },
  // AI tool directories
  { name: "There's An AI For That", url: 'https://theresanaiforthat.com', category: 'AI tools', note: 'Largest AI tool index.' },
  { name: 'Futurepedia', url: 'https://futurepedia.io', category: 'AI tools', note: 'AI tools directory.' },
  { name: 'Toolify', url: 'https://www.toolify.ai', category: 'AI tools', note: 'AI tools list with traffic data.' },
  { name: 'TopAI.tools', url: 'https://topai.tools', category: 'AI tools', note: 'AI tools directory.' },
  { name: 'Easy With AI', url: 'https://www.easywithai.com', category: 'AI tools', note: 'AI tools and guides.' },
  { name: 'AI Tools Directory', url: 'https://aitoolsdirectory.com/submit', category: 'AI tools', note: 'Free submit page.' },
  { name: 'Aixploria', url: 'https://aixploria.com/en/submit-ai/', category: 'AI tools', note: 'Free submit page.' },
  { name: 'Future Tools', url: 'https://www.futuretools.io/submit-a-tool', category: 'AI tools', note: 'Matt Wolfe’s directory, free submit.' },
  { name: 'Insidr.ai', url: 'https://www.insidr.ai/submit-tools/', category: 'AI tools', note: 'Free submit page.' },
  { name: 'SuperTools (The Rundown)', url: 'https://supertools.therundown.ai/submit', category: 'AI tools', note: 'The Rundown newsletter directory.' },
  // Business & local
  { name: 'Google Business Profile', url: 'https://www.google.com/business/', category: 'Business & local', note: 'The one listing that matters most for local search.' },
  { name: 'Bing Places', url: 'https://www.bingplaces.com', category: 'Business & local', note: 'Microsoft’s business listing.' },
  { name: 'Yelp', url: 'https://www.yelp.com', category: 'Business & local', note: 'Claim the business page.' },
  { name: 'Yellow Pages', url: 'https://www.yellowpages.com', category: 'Business & local', note: 'Classic US business directory.' },
  { name: 'Foursquare', url: 'https://foursquare.com', category: 'Business & local', note: 'Location data feeds many apps.' },
  { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org', category: 'Business & local', note: 'Add the business to the open map.' },
  { name: 'Manta', url: 'https://www.manta.com', category: 'Business & local', note: 'US small-business directory.' },
  { name: 'Hotfrog', url: 'https://www.hotfrog.com', category: 'Business & local', note: 'International business directory.' },
  { name: 'Cybo', url: 'https://www.cybo.com', category: 'Business & local', note: 'Global business listing.' },
  { name: 'Brownbook', url: 'https://www.brownbook.net', category: 'Business & local', note: 'Free global business listing.' },
  { name: 'Best of the Web', url: 'https://botw.org', category: 'Business & local', note: 'Long-running web directory.' },
  { name: 'ShowMeLocal', url: 'https://www.showmelocal.com', category: 'Business & local', note: 'Local business directory.' },
  { name: 'eLocal', url: 'https://www.elocal.com', category: 'Business & local', note: 'Local business listing.' },
  { name: 'Chamber of Commerce', url: 'https://www.chamberofcommerce.com', category: 'Business & local', note: 'US chamber directory.' },
  { name: 'BBB', url: 'https://www.bbb.org', category: 'Business & local', note: 'Accreditation and listing.' },
  { name: 'Nextdoor', url: 'https://www.nextdoor.com', category: 'Business & local', note: 'Neighborhood-level presence.' },
  { name: 'JoeAnt', url: 'https://www.joeant.com', category: 'Business & local', note: 'Volunteer-edited web directory.' },
]
