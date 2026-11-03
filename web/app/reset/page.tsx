import { Suspense } from 'react'
import { connection } from 'next/server'
import { systemMailAvailable } from '@/lib/system-mail'
import ResetForm from './reset-form'

// Runtime deployment availability only, never account-specific or baked into a build.
async function RuntimeReset() {
  await connection()
  return <ResetForm mailAvailable={systemMailAvailable()} />
}
export default function Reset() {
  return <Suspense fallback={<main className="min-h-screen flex items-center justify-center">Loading account recovery...</main>}><RuntimeReset /></Suspense>
}
