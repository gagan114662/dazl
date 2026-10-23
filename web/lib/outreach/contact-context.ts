// Source wording is evidence of the inbox's advertised purpose, never consent.
// Restriction is conservative; absent/ambiguous context stays unknown.
export interface ContactContext { excerpt: string; source_url: string; restriction?: string | null }
export function contactContext(text: string, email: string, source_url: string): ContactContext {
 const plain=text.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')
 const at=plain.toLowerCase().indexOf(email.trim().toLowerCase())
 return {excerpt:at<0?'':plain.slice(Math.max(0,at-100),at+email.length+100).slice(0,240),source_url}
}
export function contextRestriction(c?: ContactContext | null): string | null {
 if(!c)return null
 if(c.restriction)return c.restriction
 const s=c.excerpt
 if(/\b(send|submit|email)\b.{0,65}\b(cv|resum[eé]|application|cover letter)\b|\b(cv|resum[eé]|application|cover letter)\b.{0,65}\b(send|submit|email|to)\b/i.test(s))return 'recruitment context'
 if(/\b(privacy|data subject|personal data|opt.out|press inquiries|media inquiries|technical support|support requests)\b/i.test(s))return 'restricted-purpose context'
 return null
}
export function contextLabel(c:ContactContext):string {
 let excerpt=c.excerpt;const restriction=contextRestriction(c);while(JSON.stringify({excerpt,restriction}).length>180)excerpt=excerpt.slice(0,-1)
 return 'contact-context-v1:'+JSON.stringify({excerpt,restriction})
}
export function readContextLabel(label?:string|null,source_url=''):ContactContext|null {
 if(!label?.startsWith('contact-context-v1:'))return source_url?{excerpt:'',source_url}:null
 try {const c=JSON.parse(label.slice(19));return typeof c.excerpt==='string'?{excerpt:c.excerpt,source_url,restriction:typeof c.restriction==='string'?c.restriction:null}:null}catch{return source_url?{excerpt:'',source_url}:null}
}
