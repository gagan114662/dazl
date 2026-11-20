// Normal crawl extension: associate only one direct, visible, current person card.
// The caller still owns proved site identity, legacy buyer matching and transport.
import {parse,type DefaultTreeAdapterMap} from 'parse5'
type Node=DefaultTreeAdapterMap['node']
type El=DefaultTreeAdapterMap['element']
const isEl=(n:Node):n is El=>'tagName'in n
const kids=(n:Node):readonly Node[]=>'childNodes'in n?n.childNodes:[]
const attr=(n:El,key:string)=>n.attrs.find(x=>x.name===key)?.value
const heading=/^h[1-6]$/
const excluded=/\b(?:former|past team|past leadership|previously|alumni|retired|emeritus|resigned|archived?|testimonials?|customers?)\b/iu
const opaque=(n:El)=>/^(?:head|script|style|noscript|template|textarea|iframe|dialog|details|svg|math|object|embed|plaintext|del|s|strike|blockquote|select)$/.test(n.tagName)||
 ['hidden','inert','style'].some(k=>attr(n,k)!==undefined)||attr(n,'aria-hidden')?.trim().toLowerCase()==='true'||
 /(?:^|\s)(?:hidden|invisible|sr-only|visually-hidden|screen-reader-only|d-none)(?:\s|$)/i.test(attr(n,'class')??'')||
 ['class','id','aria-label','title','alt','data-status'].some(k=>excluded.test((attr(n,k)??'').replace(/[_-]+/g,' ')))
function literal(n:El){
 const loc=n.sourceCodeLocation,children=kids(n)
 return loc?.startTag&&loc.endTag&&children.length===1&&children[0].nodeName==='#text'&&'value'in children[0]
   ? children[0].value.trim():''
}
const whole=(v:string,max:number)=>!!v&&v.length<=max&&!/[<>\p{C}]/u.test(v)
const fold=(v:string)=>v.normalize('NFC').toLowerCase()
const mail=/^[a-z0-9]+(?:[._-][a-z0-9]+)*@[a-z0-9.-]+\.[a-z]{2,}$/i
const shared=/^(?:info|hello|hi|contact(?:us|o)?|enquir(?:y|ies)|inquir(?:y|ies)|sales|business|office|admin|general|mail|team|support|help|agents?|helpdesk|customerservice|assistance|assistenza|atencion|soporte|suporte|serviciocliente|kundendienst|press|media|partnerships|partners|bookings?|reservations|hola|kontakt|bonjour|ciao|ola|connect)$/i
const nameHasLocal=(name:string,local:string)=>{
 const words=name.split(/\s+/).map(s=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z]/g,''))
 const first=words[0],last=words.at(-1)
 return words.length>=2&&!!first&&!!last&&first.length>=2&&last.length>=2&&first!==last&&
  [first+last,last+first,first[0]+last,first+last[0],last+first[0]].includes(local)
}
type Card=Readonly<{name:string;quote:string;email:string|null}>
export function strictOwnContactCards(html:string,exactHost:string):readonly Card[]{
 if(Buffer.byteLength(html)>256_000)return []
 const stack=[parse(html,{sourceCodeLocationInfo:true,scriptingEnabled:true}) as Node]
 const cards:Card[]=[],names=new Set<string>()
 let count=0
 while(stack.length){
  if(++count>10_000||cards.length>80)return []
  const n=stack.pop()!
  if(isEl(n)){
   if(n.tagName==='base'||(n.tagName==='meta'&&attr(n,'http-equiv')?.trim().toLowerCase()==='refresh'))return []
   if(heading.test(n.tagName)&&excluded.test(kids(n).map(k=>'value'in k?k.value:'').join(' ')))return []
   if(opaque(n)&&n.tagName!=='head')continue
   if((n.tagName==='article'||n.tagName==='li')&&n.sourceCodeLocation?.startTag&&n.sourceCodeLocation.endTag){
    const nodes=kids(n),elements=nodes.filter(isEl)
    if(elements.every(e=>!opaque(e)&&(heading.test(e.tagName)||/^(?:p|span|a|img)$/.test(e.tagName)))&&
       nodes.every(e=>isEl(e)||!('value'in e)||!e.value.trim())){
     const heads=elements.filter(e=>heading.test(e.tagName)),roles=elements.filter(e=>/^(?:p|span)$/.test(e.tagName))
     const name=heads.length===1?literal(heads[0]):'',quote=roles.length===1?literal(roles[0]):''
     if(whole(name,60)&&whole(quote,60)&&!elements.some(e=>excluded.test(literal(e)))){
      if(names.has(fold(name)))return []
      names.add(fold(name))
      // Any second or differently written mailto is ambiguous. No decoding,
      // guesses, HTML joining, attribute-only mail or role/tagged variant.
      const links=elements.filter(e=>e.tagName==='a'&&(attr(e,'href')??'').toLowerCase().startsWith('mailto:'))
      const a=links.length===1?links[0]:null, email=a?literal(a):''
      const raw=a?.sourceCodeLocation?.attrs?.href
      const href=raw?/^href\s*=\s*(["'])([^"'&<>]+)\1$/i.exec(html.slice(raw.startOffset,raw.endOffset))?.[2]:null
      const [local,domain]=email.toLowerCase().split('@'),key=local?.replace(/[._-]/g,'')??''
      cards.push({name,quote,email:mail.test(email)&&href==='mailto:'+email&&domain===exactHost&&
        !shared.test(key)&&nameHasLocal(name,key)?email:null})
     }
    }
   }
  }
  if(stack.length+kids(n).length>10_000)return []
  stack.push(...kids(n))
 }
 // Refuse mail if the exact local also names a different observed person.
 return cards.map(c=>c.email&&cards.some(d=>d!==c&&nameHasLocal(d.name,c.email!.split('@')[0].replace(/[._-]/g,'').toLowerCase()))
  ? {...c,email:null}:c)
}
