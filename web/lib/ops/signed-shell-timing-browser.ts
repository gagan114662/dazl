// Inline document probe, before chunks. No dependency on React hydration.
export const SIGNED_SHELL_TIMING_BROWSER = `(()=>{
 try {
  const route=location.pathname;
  if(route!=='/app'&&route!=='/app/business'&&route!=='/app/plays')return;
  const nav=performance.getEntriesByType('navigation')[0];
  const metric=nav&&nav.serverTiming&&nav.serverTiming.find(x=>x.name==='dazl_request');
  const receipt=metric&&metric.description;
  const id=(receipt||'').split('.')[0];
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id||''))return;
  let js=0,css=0,marker=null,done=false;
  const ms=x=>Number.isFinite(x)&&x>=0?Math.min(120000,Math.round(x)):null;
  const errors=e=>{
   const el=e.target;
   if(!el||!(el instanceof Element))return;
   const raw=el.tagName==='SCRIPT'?el.getAttribute('src'):
    el.tagName==='LINK'&&(el.getAttribute('rel')==='stylesheet'||el.getAttribute('as')==='style')?el.getAttribute('href'):null;
   if(!raw)return;
   try{
    const u=new URL(raw,location.origin);
    if(u.origin!==location.origin||!u.pathname.startsWith('/_next/static/'))return;
    if(el.tagName==='SCRIPT'&&u.pathname.endsWith('.js'))js=Math.min(8,js+1);
    if(el.tagName==='LINK'&&u.pathname.endsWith('.css'))css=Math.min(8,css+1);
   }catch {}
  };
  function observe(){
   const m=document.querySelector('#main [data-signed-shell-auth-marker]');
   if(marker===null&&m&&!m.closest('[hidden]'))marker=ms(performance.now());
  }
  const observer=new MutationObserver(observe);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  addEventListener('error',errors,true);
  function report(observation){
   if(done)return;
   done=true;observe();observer.disconnect();removeEventListener('error',errors,true);
   const ttfb=nav.requestStart>0&&nav.responseStart>0?ms(nav.responseStart-nav.requestStart):null;
   fetch('/api/client-errors',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,
    body:JSON.stringify({kind:'signed_shell_timing',route,request_id:id,receipt,ttfb_ms:ttfb,auth_marker_ms:marker,
     js_failed:js,css_failed:css,observation})}).catch(()=>{});
  }
  addEventListener('load',()=>setTimeout(()=>report('load'),0),{once:true});
  addEventListener('pagehide',()=>{if(js||css)report('pagehide')},{once:true});
  setTimeout(()=>report('deadline'),12500);
 }catch{}
})();`
