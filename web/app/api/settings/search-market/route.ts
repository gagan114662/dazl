import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { requireUser } from '@/lib/scan/service'
import { isoCountry } from '@/lib/scan/icp'
import { marketLanguage } from '@/lib/scan/search-market'
import { captureAccountMarket, readAccountMarket, writeAccountMarket } from '@/lib/settings/search-market-store'
import { denied } from '@/lib/workspace-access'
import { sameOriginJson } from '@/lib/same-origin'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(await readAccountMarket(await getDb(), user.tenantId))
}

export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure')
  if (no) return no
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const db = await getDb()
  if (typeof body.locale === 'string') {
    await captureAccountMarket(db, user.tenantId, body.locale)
  } else {
    const country = isoCountry(body.country)
    const language = marketLanguage(body.language)
    if ((!country && body.country !== '') || (!language && body.language !== '')) {
      return NextResponse.json({ error: 'Enter a country code and a language code, or leave either blank.' }, { status: 400 })
    }
    await writeAccountMarket(db, user.tenantId, { country, language })
  }
  return NextResponse.json(await readAccountMarket(db, user.tenantId))
}
