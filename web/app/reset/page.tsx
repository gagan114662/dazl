import { connection } from 'next/server'
import { systemMailAvailable } from '@/lib/system-mail'
import ResetForm from './reset-form'

// Runtime deployment availability only, never account-specific or baked into a build.
export default async function Reset() {
  await connection()
  return <ResetForm mailAvailable={systemMailAvailable()} />
}
