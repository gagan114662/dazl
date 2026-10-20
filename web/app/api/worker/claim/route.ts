import { NextRequest, NextResponse } from 'next/server'
import { checkWorker } from '@/lib/worker-auth'
import { getScanDb } from '@/lib/scan/service'
import { claimNextJob } from '@/lib/scan/store'

// POST: claim the oldest pending job. 200 with the job, or 204 when none.
export async function POST(req: NextRequest) {
  const denied = checkWorker(req)
  if (denied) return denied
  const job = claimNextJob(getScanDb())
  return job ? NextResponse.json(job) : new NextResponse(null, { status: 204 })
}
