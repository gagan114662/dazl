type TargetBase = {summary:string;who:string[];where:string[];industries:string[];signals:string[];country?:unknown}
export type TargetFields = {summary:string;who:string;where:string;industries:string;signals:string;country:string}
const lists = ['who','where','industries','signals'] as const
export function targetFields(p:TargetBase):TargetFields {
  return {summary:p.summary,who:p.who.join('; '),where:p.where.join('; '),
    industries:p.industries.join('; '),signals:p.signals.join('; '),country:typeof p.country==='string'?p.country:''}
}
export function buildManualNativeTarget<T extends TargetBase>(sentence:string,p:T,fields:TargetFields):string|null {
  const query=sentence.trim(), summary=fields.summary.trim(), country=fields.country.trim().toUpperCase()
  if(query.length<3||query.length>600||!summary||country&&!/^[A-Z]{2}$/.test(country)) return null
  const icp={...p,summary}
  for(const key of lists){
    icp[key]=fields[key]===p[key].join('; ') ? [...p[key]] : fields[key].split(';').map(s=>s.trim()).filter(Boolean)
    // Removing a formerly present category broadens an existing criterion. Replace it instead.
    if(p[key].length&&!icp[key].length) return null
  }
  if(p.country && !country && !icp.where.length) return null
  if(country) icp.country=country
  else delete icp.country // Explicitly choosing no single country; a reviewed locality still anchors the search if replacing a saved country.
  return JSON.stringify({query,icp,mode:'first5',budget:{web_search:'anthropic_estimated_v1',target_review:'manual_v1'}})
}

export type AcceptedTarget = Readonly<{
  query:string;summary:string;who:readonly string[];where:readonly string[];country?:string;
  industries:readonly string[];signals:readonly string[];sizes:readonly string[];exclude:readonly string[];
  language?:string;window_days?:number;
}>
/** Never use the raw submitted ICP for a job readback or buyer selection. */
export function acceptedTarget(value: unknown, sentQuery: string): AcceptedTarget | null {
  if (!value || typeof value!=='object' || Array.isArray(value)) return null
  const o = value as Record<string,unknown>
  if (typeof o.query!=='string'||o.query!==sentQuery||typeof o.summary!=='string'||!o.summary.trim()) return null
  if (o.country!==undefined && (typeof o.country!=='string'||!/^[A-Z]{2}$/.test(o.country))) return null
  if (o.language!==undefined && (typeof o.language!=='string'||!/^[a-z]{2}$/.test(o.language))) return null
  if (o.window_days!==undefined && (typeof o.window_days!=='number'||!Number.isInteger(o.window_days)||o.window_days<1||o.window_days>365)) return null
  const validList=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(item=>typeof item==='string'&&!!item.trim())
  if(!validList(o.who)||!validList(o.where)||!validList(o.industries)||!validList(o.signals)||!validList(o.sizes)||!validList(o.exclude)) return null
  return Object.freeze({query:o.query,summary:o.summary,who:Object.freeze([...o.who]),where:Object.freeze([...o.where]),
    industries:Object.freeze([...o.industries]),signals:Object.freeze([...o.signals]),
    sizes:Object.freeze([...o.sizes]),exclude:Object.freeze([...o.exclude]),...(typeof o.country==='string' ? {country:o.country} : {}),
    ...(typeof o.language==='string' ? {language:o.language} : {}),...(typeof o.window_days==='number' ? {window_days:o.window_days} : {})})
}
