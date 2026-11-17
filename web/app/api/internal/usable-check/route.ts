import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getDb } from '@/lib/db/client'
import { usableLeadsByJob } from '@/lib/growth/funnel'
import { buildProofPreview, loadProofInput } from '@/lib/scan/proof-preview'

// #1176 operator check: for ONE finished run, what the two operator-only readers of "a usable lead" answer on this
// deployment, so they can be checked live without a growth-workspace session and without issuing a preview:
//   funnel_usable   lib/growth/funnel.ts usableLeadsByJob, the exact count the growth funnel uses for that run
//   proof_preview   lib/scan/proof-preview.ts buildProofPreview over the run's own leads (the owner's tenant), with a
//                   stand-in offer, so only the lead gates decide; nothing is stored, issued, claimed or sent
// Read-only: no write, no model call, no network. Counts and a status only: never a company, person, email or URL.
// Operator only: the same shared secret as /api/internal/tick. Without it configured, or with a wrong one, the route
// does not exist (404).
const JOB_ID = /^[A-Za-z0-9_-]{6,64}$/
const STAND_IN_OFFER = { text: 'operator check (stand-in offer)', sourceUrl: 'https://dazl.ai/' }

export async function GET(req: NextRequest) {
  const secret = process.env.AUTOPILOT_TICK_SECRET
  const got = req.headers.get('authorization') ?? ''
  const want = `Bearer ${secret}`
  const a = Buffer.from(got), b = Buffer.from(want)
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const headers = { 'Cache-Control': 'no-store' }
  const job = req.nextUrl.searchParams.get('job')
  if (!job || !JOB_ID.test(job)) return NextResponse.json({ error: 'invalid_job' }, { status: 400, headers })
  const db = await getDb()
  const owner = await db.get<{ user_id: string }>('SELECT user_id FROM scan_jobs WHERE id = ?', [job])
  if (!owner) return NextResponse.json({ error: 'unknown_job' }, { status: 404, headers })
  const funnelUsable = (await usableLeadsByJob(db, job)).get(job) ?? 0
  const input = await loadProofInput(db, owner.user_id, job, { inferredOffer: STAND_IN_OFFER, spendUsd: null })
  const preview = input ? buildProofPreview(input) : null
  return NextResponse.json({
    job,
    funnel_usable: funnelUsable,
    proof_preview: preview === null ? { status: 'hold', reason: 'unknown_job', companies: 0 }
      : preview.status === 'ready' ? { status: 'ready', companies: preview.companies.length }
      : { status: 'hold', reason: preview.reason, companies: 0 },
    offer: 'stand-in',
  }, { headers })
}
