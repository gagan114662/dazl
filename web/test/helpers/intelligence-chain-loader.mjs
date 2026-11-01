import {resolve as siteResolve} from './icp-from-url-route-loader.mjs'
export async function resolve(specifier,context,nextResolve){
 if(specifier==='@/lib/auth-db')return {url:new URL('./scan-route-auth-stub.ts',import.meta.url).href,shortCircuit:true}
 return siteResolve(specifier,context,nextResolve)
}
