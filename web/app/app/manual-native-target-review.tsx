'use client'
import {useState, type FormEvent} from 'react'
import type {TargetFields} from './manual-native-target'
const fields = [
  ['summary','Buyer description'], ['who','Buyer roles'], ['where','Locations'],
  ['country','Country restriction (two-letter code, or blank for no single country)'],
  ['industries','Industries'], ['signals','Buying signals'],
] as const
export default function ManualNativeTargetReview({query,initial,retained,makeBody,onConfirm,onCancel}:{
  query:string;initial:TargetFields;retained:readonly string[];makeBody:(draft:TargetFields)=>string|null;
  onConfirm:(body:string)=>void;onCancel:()=>void
}) {
  const [draft,setDraft]=useState(initial)
  const [error,setError]=useState(false)
  function doConfirm(e:FormEvent) {
    e.preventDefault()
    const body=makeBody(draft)
    if(!body){setError(true);return}
    onConfirm(body)
  }
  return <section className="card max-w-2xl mx-auto p-5" aria-label="Review targets for this search"
    onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();onCancel()}}}>
    <h2 className="text-xl font-bold">Review targets for this search</h2>
    <div className="my-2">{query}</div>
    <div className="text-sm">These changes apply only to this search. Keep a location, industry and signal that match your request. Separate multiple entries with semicolons.</div>
    <form className="space-y-2 mt-3" onSubmit={doConfirm}>
      {fields.map(([key,title])=><label key={key} className="block text-sm">{title}
        <input className="field w-full" value={draft[key]} onChange={e=>{setError(false);setDraft({...draft,[key]:e.target.value})}} />
      </label>)}
      {retained.length>0&&<div className="text-sm" aria-label="Unchanged search criteria">
        <strong>Stays the same for this search:</strong><ul>{retained.map(row=><li key={row}>{row}</li>)}</ul>
      </div>}
      {error&&<div role="alert">Check the target details. Replace any existing criterion rather than leaving it empty.</div>}
      <div className="text-sm">Uses your Anthropic key. Target cost is under US$5; actual charges can vary and may exceed that estimate.</div>
      <button type="submit" className="btn-primary">Confirm targets and find leads</button>{' '}
      <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
    </form>
  </section>
}
