import type { OutreachProvenance } from '@/lib/outreach/provenance'
import { eventDateCopy } from '@/lib/scan/date-copy'

export default function Provenance({ value }: { value: OutreachProvenance | null | undefined }) {
  if (!value) return <p className="text-xs text-[#555] mb-3">Linked source context unavailable. Contact publication, date and current need are not confirmed here.</p>
  return <div className="border-l-2 border-black/30 pl-3 mb-3 text-xs text-[#555]">
    <p>{eventDateCopy(value.event_date,value.date_status)}</p>
    <p className="mt-1">Public contact is not a named buyer or consent. Workload fit is not buying intent.</p>
    <details className="mt-2">
      <summary className="cursor-pointer underline">Source and contact context</summary>
      <p className="mt-2">Current linked records, not a draft-time verification snapshot.</p>
      <p className="mt-2">Saved signal claim for {value.company}: {value.signal}</p>
      {value.excerpt && <blockquote className="mt-2 whitespace-pre-wrap">Saved quote (not a new verification): "{value.excerpt}"</blockquote>}
      {value.source_url && <a className="underline break-all block mt-2" href={value.source_url} target="_blank" rel="noopener noreferrer">{value.source_url}</a>}
      <p className="mt-2">Contact origin: {value.contact_origin==='lead_record'?'address matches the saved lead contact':value.contact_origin==='sitecrawl_record'?'address matches a saved sitecrawl email record':'not established from the current linked records'}. Publication has not been rechecked here.{value.contact_origin==='lead_record' && ' No separate contact-source URL is stored on the lead.'}</p>
      {value.contact_source_url && <a className="underline break-all block mt-1" href={value.contact_source_url} target="_blank" rel="noopener noreferrer">Contact source record: {value.contact_source_url}</a>}
    </details>
  </div>
}
