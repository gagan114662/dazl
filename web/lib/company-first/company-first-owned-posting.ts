// Exact literal backlink on the already guarded, independently verified company
// document. Static markup only; this is not a page render or identity issuer.
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { atsPostingRef } from '../sources/ats-posting.ts'
export function hasExactOwnedPosting(html:string,posting:string):boolean{
  if(atsPostingRef(posting)?.kind!=='greenhouse'||html.length>128_000)return false
  const tree=parse(html,{scriptingEnabled:true,sourceCodeLocationInfo:true})
  const stack:{node:DefaultTreeAdapterMap['node'];allowed:boolean;body:boolean}[]=[{node:tree,allowed:true,body:false}]
  let count=0, visited=0
  while(stack.length){
    if(++visited>10_000)return false
    const {node,allowed,body}=stack.pop()!
    let visible=allowed,inBody=body
    if('tagName' in node){
      const tag=node.tagName
      const attr=(k:string)=>node.attrs.find(a=>a.name===k)?.value
      if(tag==='base'||(tag==='meta'&&attr('http-equiv')?.trim().toLowerCase()==='refresh'))return false
      visible=visible&&!/^(?:head|template|script|style|noscript|textarea|iframe|dialog|details|svg|math|object|embed|select)$/.test(tag)&&
        attr('hidden')===undefined&&attr('inert')===undefined&&attr('style')===undefined&&
        attr('aria-hidden')?.trim().toLowerCase()!=='true'&&!/(?:^|\s)(?:hidden|invisible|sr-only|visually-hidden|d-none)(?:\s|$)/i.test(attr('class')??'')
      inBody=body||tag==='body'
      const loc=node.sourceCodeLocation
      const content=node.childNodes
      if(visible&&inBody&&tag==='a'&&attr('href')===posting&&loc?.startTag&&loc.endTag&&loc.attrs?.href&&
        content.length===1&&'value' in content[0]&&!!content[0].value.trim()){
        const raw=html.slice(loc.attrs.href.startOffset,loc.attrs.href.endOffset)
        if(raw.includes(posting))count++
      }
    }
    if('childNodes' in node)for(const child of node.childNodes)stack.push({node:child,allowed:visible,body:inBody})
  }
  return count===1
}
