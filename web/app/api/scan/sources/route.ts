import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { tinyfishEnabled } from '@/lib/search/tinyfish'
import { newsEnabled } from '@/lib/search/news'
import { sitecrawlEnabled } from '@/lib/connectors/sitecrawl'

// Which server-wide sources this deployment has switched on (the same checks the scan runner makes). Read-only, no
// tenant data and never a credential: only on/off, so the Leads page can say what a scan will and will not search.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ web_index: tinyfishEnabled(), news: newsEnabled(), websites: sitecrawlEnabled() })
}
