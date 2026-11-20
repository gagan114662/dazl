type TargetBase = {summary:string;who:string[];where:string[];industries:string[];signals:string[];country?:unknown}
export type TargetFields = {summary:string;who:string;where:string;industries:string;signals:string;country:string}
const lists = ['who','where','industries','signals'] as const
export function targetFields(p:TargetBase):TargetFields {
  return {summary:p.summary,who:p.who.join('; '),where:p.where.join('; '),
    industries:p.industries.join('; '),signals:p.signals.join('; '),country:typeof p.country==='string'?p.country:''}
}
export function buildManualNativeTarget<T extends TargetBase>(sentence:string,p:T,fields:TargetFields,decisions:unknown):string|null {
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
  return JSON.stringify({query,icp,research_decisions:decisions,mode:'first5',budget:{web_search:'anthropic_estimated_v1'}})
}

/** Display from the exact accepted request, not from whichever profile is visible later. */
export function submittedTarget(body: string): Readonly<{ summary:string; who:readonly string[] }> {
  const { summary, who } = JSON.parse(body).icp as TargetBase
  return Object.freeze({ summary, who:Object.freeze([...who]) })
}
