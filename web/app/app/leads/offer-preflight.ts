// Client projection of the authenticated same-endpoint choice response.
export function scanOfferConflict(status:number,value:unknown) {
  if(status!==409||!value||typeof value!=='object')return null
  const fields=value as Record<string,unknown>
  if(fields.error!=='offer_conflict'||typeof fields.saved!=='string'||(!fields.saved.trim()&&fields.incomplete!==true)||
    (fields.stated!==null&&typeof fields.stated!=='string'))return null
  return {stated:fields.stated,saved:fields.saved,ambiguous:fields.ambiguous===true,
    ...(fields.incomplete===true?{incomplete:true}:{}),
    ...(fields.fresh_target===true?{freshTarget:true}:{}),
    ...(typeof fields.withdrawn==='string'?{withdrawn:fields.withdrawn}:{})}
}

// Only an explicit selection of the recorded offer can carry its old buyer
// in a direct run. The reviewed editor's profile is a separate server input.
export function directOfferProfile<T>(chosen:string,saved:string,carried:T|null,freshTarget=false):T|null {
  return !freshTarget&&chosen===saved?carried:null
}
