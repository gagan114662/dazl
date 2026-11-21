import { connection } from 'next/server'
import { systemMailAvailable } from '@/lib/system-mail'
import ResetForm from './reset-form'

// Runtime deployment availability only, never account-specific or baked into a build.
// #1428: the form used to sit behind a Suspense boundary, so dazl.ai showed a loading line for seconds until
// the streamed part was swapped in. As on sign-up (app/sign-up/page.tsx, #668/#670): connection() with NO Suspense boundary,
// plus `instant = false`, so the route answers once connection() resolves (near-instant) with the complete form in the
// first HTML, and it hydrates normally.
export const instant = false
export default async function Reset() {
  await connection()
  return <ResetForm mailAvailable={systemMailAvailable()} />
}
