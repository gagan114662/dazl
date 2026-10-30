'use client'
import { useEffect } from 'react'
import { installClientErrorReporting } from '@/lib/client-error-report'

// Mounted once in the root layout: reports uncaught browser errors (lib/client-error-report.ts). Renders nothing.
export default function ClientErrorReporter() {
  useEffect(() => { installClientErrorReporting() }, [])
  return null
}
