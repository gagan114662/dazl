// Tenant dashboard: one HTML document served at /app. It holds no data; all
// data comes from the authenticated /v1 API using the tenant's API key (kept
// in sessionStorage only). Strict nonce-based CSP; every dynamic value is
// rendered with textContent, never innerHTML.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dazl</title>
<style nonce="__NONCE__">
:root{--bg:#f6f5f2;--surface:#fff;--ink:#1b1c1a;--muted:#6a6c66;--line:#e2e0da;--accent:#0f6b5c;--accent-ink:#fff;--warn:#a4400f;--bad:#a12626}
@media(prefers-color-scheme:dark){:root{--bg:#141513;--surface:#1c1d1a;--ink:#ecebe6;--muted:#9a9c94;--line:#2c2d29;--accent:#4fc3ad;--accent-ink:#0c1f1b;--warn:#e29a5f;--bad:#ee7f7f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:1.25rem;padding:.75rem 1.25rem;border-bottom:1px solid var(--line);background:var(--surface);flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:-.02em;font-size:1.15rem}
nav{display:flex;gap:.25rem;flex:1;flex-wrap:wrap}
nav button{background:none;border:0;color:var(--muted);padding:.4rem .75rem;border-radius:6px;font:inherit;cursor:pointer}
nav button[aria-current=true]{background:var(--bg);color:var(--ink);font-weight:600}
main{max-width:64rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
h2{font-size:1.1rem;margin:2rem 0 .75rem}h2:first-child{margin-top:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1rem 1.1rem;margin-bottom:.75rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:.75rem}
.meter .label{color:var(--muted);font-size:.85rem}.meter .val{font-size:1.4rem;font-weight:650;font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:3px;background:var(--line);margin-top:.5rem;overflow:hidden}.bar>i{display:block;height:100%;background:var(--accent)}
input,textarea,select{width:100%;padding:.5rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:5.5rem;resize:vertical}label{display:block;font-size:.85rem;color:var(--muted);margin:.6rem 0 .2rem}
button.primary,button.sec{padding:.45rem .9rem;border-radius:6px;font:inherit;cursor:pointer;border:1px solid var(--accent)}
button.primary{background:var(--accent);color:var(--accent-ink)}button.sec{background:none;color:var(--accent)}
button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.row.sp{justify-content:space-between;margin-bottom:.4rem}
.muted{color:var(--muted)}.pill{font-size:.75rem;padding:.1rem .5rem;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.score{font-weight:700;font-variant-numeric:tabular-nums;min-width:2.4rem}
pre{white-space:pre-wrap;font:inherit;margin:.4rem 0 0}
#toast{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:.55rem 1rem;border-radius:8px;max-width:90vw;display:none}
#login{max-width:26rem;margin:12vh auto;padding:0 1.25rem}
.empty{color:var(--muted);padding:1.25rem 0}
@media(max-width:560px){main{padding:1rem .9rem 4rem}nav{order:3;flex-basis:100%}header{gap:.5rem 1rem}.brand{flex:1}}
.mb1{margin-bottom:.25rem}.mt5{margin-top:.5rem}.mt75{margin-top:.75rem}.mt9{margin-top:.9rem}.mt1{margin-top:1rem}.err{color:var(--bad)}.variant{margin-top:.6rem;padding-top:.6rem;border-top:1px solid var(--line)}
</style></head><body>
<div id="app"></div><div id="toast" role="status" aria-live="polite"></div>
<script nonce="__NONCE__">
(function(){
var KEY_NAME='dazl_key';
var app=document.getElementById('app');
var state={tab:'overview'};
function key(){return sessionStorage.getItem(KEY_NAME)}
function h(tag,attrs){var e=document.createElement(tag);attrs=attrs||{};
 for(var k in attrs){if(k==='class')e.className=attrs[k];else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),attrs[k]);else if(attrs[k]!==false&&attrs[k]!=null)e.setAttribute(k,attrs[k]);}
 (function add(list){for(var i=0;i<list.length;i++){var c=list[i];if(c==null||c===false)continue;if(Array.isArray(c)){add(c);continue}e.appendChild(typeof c==='string'||typeof c==='number'?document.createTextNode(String(c)):c);}})(Array.prototype.slice.call(arguments,2));
 return e}
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(function(){t.style.display='none'},4000)}
function api(method,path,body){
 return fetch(path,{method:method,headers:Object.assign({'Authorization':'Bearer '+key()},body?{'content-type':'application/json'}:{}),body:body?JSON.stringify(body):undefined})
 .then(function(r){return r.json().catch(function(){return {}}).then(function(d){
  if(r.status===401){sessionStorage.removeItem(KEY_NAME);render();throw new Error('Signed out: key rejected')}
  if(r.status===402)throw new Error('Plan limit reached ('+(d.kind||'quota')+': '+d.used+'/'+d.limit+'). Upgrade to continue.');
  if(!r.ok)throw new Error(d.message||d.error||('Request failed ('+r.status+')'));
  return d})})}
function act(btn,fn){return function(){btn=btn||this;btn.disabled=true;Promise.resolve().then(fn).catch(function(e){toast(e.message)}).then(function(){btn.disabled=false})}}

function loginView(){
 var input=h('input',{type:'password',id:'k',placeholder:'dazl_...',autocomplete:'off'});
 var form=h('form',{onsubmit:function(ev){ev.preventDefault();sessionStorage.setItem(KEY_NAME,input.value.trim());api('GET','/v1/usage').then(function(){render()}).catch(function(e){sessionStorage.removeItem(KEY_NAME);toast(e.message)})}},
  h('label',{for:'k'},'API key'),input,h('div',{class:'row mt1'},h('button',{class:'primary',type:'submit'},'Sign in')));
 return h('div',{id:'login'},h('div',{class:'brand mb1'},'dazl'),h('p',{class:'muted'},'Sign in with your tenant API key. It stays in this browser tab only.'),form)}

function barFill(pct){var i=document.createElement('i');i.style.width=pct+'%';return i}
function meter(label,o){var pct=o.limit?Math.min(100,Math.round(100*o.used/o.limit)):0;
 return h('div',{class:'card meter'},h('div',{class:'label'},label),h('div',{class:'val'},o.used+' / '+o.limit),h('div',{class:'bar'},barFill(pct)))}

function overview(el){
 api('GET','/v1/usage').then(function(u){
  el.appendChild(h('h2',null,'Plan: '+u.plan));
  el.appendChild(h('div',{class:'grid'},meter('Employees',u.employees),meter('Cycles this month',u.cycles),meter('LLM calls this month',u.llmCalls),meter('Emails this month',u.emailsSent)));
  if(u.plan==='free'){var b=h('button',{class:'primary'},'Upgrade to Pro');b.addEventListener('click',act(b,function(){return api('POST','/v1/billing/checkout').then(function(d){location.href=d.url})}));
   el.appendChild(h('div',{class:'mt1'},b))}
 }).catch(function(e){toast(e.message)})}

function employees(el){
 var name=h('input',{placeholder:'researcher',maxlength:'64'}),role=h('input',{placeholder:'Market researcher'}),goal=h('textarea',{placeholder:'What should this employee work on?'});
 var hire=h('button',{class:'primary'},'Hire and start cycle');
 hire.addEventListener('click',act(hire,function(){return api('POST','/v1/employees',{employeeName:name.value.trim(),role:role.value.trim(),goal:goal.value.trim()}).then(function(){toast('Started');render()})}));
 el.appendChild(h('div',{class:'card'},h('label',null,'Name (lowercase-kebab)'),name,h('label',null,'Role'),role,h('label',null,'Goal'),goal,h('div',{class:'mt9'},hire)));
 var list=h('div');el.appendChild(h('h2',null,'Team'));el.appendChild(list);
 api('GET','/v1/employees').then(function(d){
  if(!d.employees.length)list.appendChild(h('div',{class:'empty'},'No employees yet. Hire one above.'));
  d.employees.forEach(function(e){var mem=h('div');var card=h('div',{class:'card'},h('div',{class:'row sp'},h('strong',null,e.employeeName),h('span',{class:'pill'},e.role)),h('div',{class:'muted'},e.goal||''),mem);
   var more=h('button',{class:'sec mt5'},'Show recent lessons');
   more.addEventListener('click',act(more,function(){return api('GET','/v1/employees/'+e.employeeName).then(function(d){mem.textContent='';if(!d.memories.length)mem.appendChild(h('div',{class:'muted'},'No lessons yet.'));d.memories.forEach(function(m){mem.appendChild(h('pre',null,m.content))})})}));
   card.appendChild(more);list.appendChild(card)})}).catch(function(e){toast(e.message)})}

function leads(el){
 var desc=h('textarea',{placeholder:'Who is your ideal customer?'}),offer=h('textarea',{placeholder:'What are you offering them?'});
 var sn=h('input',{placeholder:'Your name or company'}),pa=h('input',{placeholder:'Postal address (required for outbound email)'});
 api('GET','/v1/icp').then(function(i){desc.value=i.description||'';offer.value=i.offer||''});
 api('GET','/v1/profile').then(function(p){sn.value=p.senderName||'';pa.value=p.postalAddress||''});
 var saveIcp=h('button',{class:'sec'},'Save profile and ICP');
 saveIcp.addEventListener('click',act(saveIcp,function(){return api('PUT','/v1/icp',{description:desc.value,offer:offer.value}).then(function(){return api('PUT','/v1/profile',{senderName:sn.value,postalAddress:pa.value})}).then(function(){toast('Saved')})}));
 el.appendChild(h('h2',null,'Ideal customer and sender'));
 el.appendChild(h('div',{class:'card'},h('label',null,'Ideal customer'),desc,h('label',null,'Offer'),offer,h('label',null,'Sender name'),sn,h('label',null,'Postal address'),pa,h('div',{class:'mt9'},saveIcp)));
 var imp=h('textarea',{placeholder:'One lead per line: name, email, company, title, signal'});
 var doImp=h('button',{class:'primary'},'Import leads');
 doImp.addEventListener('click',act(doImp,function(){
  var rows=imp.value.split('\\n').map(function(l){return l.trim()}).filter(Boolean).map(function(l){var p=l.split(',').map(function(x){return x.trim()});return {name:p[0],email:p[1],company:p[2]||null,title:p[3]||null,signal:p.slice(4).join(', ')||null}});
  return api('POST','/v1/leads',{leads:rows}).then(function(d){toast('Imported '+d.imported+', duplicates '+d.duplicates+', rejected '+d.rejected.length);render()})}));
 el.appendChild(h('h2',null,'Leads'));el.appendChild(h('div',{class:'card'},imp,h('div',{class:'mt75'},doImp)));
 var list=h('div');el.appendChild(list);
 api('GET','/v1/leads?limit=100').then(function(d){
  if(!d.leads.length)list.appendChild(h('div',{class:'empty'},'No leads yet.'));
  d.leads.forEach(function(l){
   var sc=h('button',{class:'sec'},'Score'),dr=h('button',{class:'sec'},'Draft email');
   sc.addEventListener('click',act(sc,function(){return api('POST','/v1/leads/'+l.leadId+'/score').then(function(){render()})}));
   dr.addEventListener('click',act(dr,function(){return api('POST','/v1/leads/'+l.leadId+'/draft',{}).then(function(){toast('Draft created: review it under Drafts')})}));
   list.appendChild(h('div',{class:'card'},h('div',{class:'row sp'},h('div',{class:'row'},h('span',{class:'score'},l.score==null?'-':l.score),h('strong',null,l.name),h('span',{class:'muted'},[l.title,l.company].filter(Boolean).join(' at '))),h('span',{class:'pill'},l.status)),
    h('div',{class:'muted'},l.email),l.scoreReason?h('div',null,l.scoreReason):null,l.signal?h('div',{class:'muted'},'Signal: '+l.signal):null,
    l.status==='suppressed'?null:h('div',{class:'row mt5'},sc,dr)))})}).catch(function(e){toast(e.message)})}

function drafts(el){
 var list=h('div');el.appendChild(h('h2',null,'Outreach drafts'));el.appendChild(h('p',{class:'muted'},'Nothing is sent until you approve a draft and press Send.'));el.appendChild(list);
 api('GET','/v1/drafts').then(function(d){
  if(!d.drafts.length)list.appendChild(h('div',{class:'empty'},'No drafts yet. Create one from a lead.'));
  d.drafts.forEach(function(x){
   var subj=h('input',{value:x.subject}),body=h('textarea',null,x.body);body.value=x.body;
   var btns=h('div',{class:'row mt5'});
   function mk(label,cls,fn){var b=h('button',{class:cls},label);b.addEventListener('click',act(b,fn));btns.appendChild(b)}
   if(x.status==='draft'){
    mk('Save edits','sec',function(){return api('PATCH','/v1/drafts/'+x.draftId,{subject:subj.value,body:body.value}).then(function(){toast('Saved')})});
    mk('Approve','primary',function(){return api('POST','/v1/drafts/'+x.draftId+'/approve').then(render)});
    mk('Reject','sec',function(){return api('POST','/v1/drafts/'+x.draftId+'/reject').then(render)});
   }else if(x.status==='approved'){mk('Send now','primary',function(){return api('POST','/v1/drafts/'+x.draftId+'/send').then(function(){toast('Sent');render()})})}
   var editable=x.status==='draft';
   list.appendChild(h('div',{class:'card'},h('div',{class:'row sp'},h('strong',null,editable?'':x.subject),h('span',{class:'pill'},x.status)),editable?subj:null,editable?body:h('pre',null,x.body),x.error?h('div',{class:'err'},x.error):null,btns))})}).catch(function(e){toast(e.message)})}

function creatives(el){
 var ch=h('select',null,['linkedin','x','instagram','facebook','tiktok','email'].map(function(c){return h('option',{value:c},c)}));
 var brief=h('textarea',{placeholder:'What are we promoting, and to whom?'}),voice=h('input',{placeholder:'Brand voice (optional)'});
 var go=h('button',{class:'primary'},'Generate 3 variants');
 go.addEventListener('click',act(go,function(){return api('POST','/v1/creatives',{channel:ch.value,brief:brief.value,brandVoice:voice.value}).then(function(){render()})}));
 el.appendChild(h('h2',null,'Creative studio'));el.appendChild(h('div',{class:'card'},h('label',null,'Channel'),ch,h('label',null,'Brief'),brief,h('label',null,'Brand voice'),voice,h('div',{class:'mt9'},go)));
 var list=h('div');el.appendChild(list);
 api('GET','/v1/creatives').then(function(d){
  if(!d.creatives.length)list.appendChild(h('div',{class:'empty'},'No creatives yet.'));
  d.creatives.forEach(function(c){var card=h('div',{class:'card'},h('div',{class:'row sp'},h('strong',null,c.channel),h('span',{class:'muted'},c.brief.slice(0,80))));
   c.variants.forEach(function(v){card.appendChild(h('div',{class:'variant'},h('strong',null,v.headline),h('pre',null,v.body),v.cta?h('div',{class:'muted'},'CTA: '+v.cta):null))});
   list.appendChild(card)})}).catch(function(e){toast(e.message)})}

var TABS=[['overview','Overview',overview],['employees','Team',employees],['leads','Leads',leads],['drafts','Drafts',drafts],['creatives','Creatives',creatives]];
function render(){
 app.textContent='';
 if(!key()){app.appendChild(loginView());return}
 var nav=h('nav');TABS.forEach(function(t){nav.appendChild(h('button',{'aria-current':state.tab===t[0]?'true':'false',onclick:function(){state.tab=t[0];render()}},t[1]))});
 var out=h('button',{class:'sec',onclick:function(){sessionStorage.removeItem(KEY_NAME);render()}},'Sign out');
 app.appendChild(h('header',null,h('span',{class:'brand'},'dazl'),nav,out));
 var main=h('main');app.appendChild(main);
 TABS.filter(function(t){return t[0]===state.tab})[0][2](main)}
render();
})();
</script></body></html>`;

export function dashboardResponse(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(PAGE.replaceAll("__NONCE__", nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
