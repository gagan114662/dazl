import { Suspense } from 'react'
import TableClient from './table-client'

export default function LeadsTable() {
  return <Suspense fallback={<div className="p-8"><p className="text-sm text-[#555]">Loading your leads...</p></div>}><TableClient /></Suspense>
}
