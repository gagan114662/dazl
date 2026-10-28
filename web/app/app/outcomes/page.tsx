import { Suspense } from 'react'
import OutcomesClient from './outcomes-client'

export default function OutcomesPage() {
  return <Suspense fallback={null}><OutcomesClient /></Suspense>
}
