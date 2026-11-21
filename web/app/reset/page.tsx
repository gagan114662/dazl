import { Suspense } from 'react'
import { connection } from 'next/server'
import { systemMailAvailable } from '@/lib/system-mail'
import ResetForm from './reset-form'

// Runtime deployment availability only, never account-specific or baked into a build.
async function RuntimeReset() {
  await connection()
  return <ResetForm mailAvailable={systemMailAvailable()} />
}
// #1428: the fallback is the form itself (mail state not yet known), so the first HTML is already usable; the runtime
// part only replaces it with the same form once it knows whether this deployment can send mail.
export default function Reset() {
  return <Suspense fallback={<ResetForm mailAvailable={null} />}><RuntimeReset /></Suspense>
}
