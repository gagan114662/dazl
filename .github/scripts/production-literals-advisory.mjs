// Trusted base launcher; never execute or import code from the candidate tree.
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
const [eventFile, objects, sandbox, boot, fixtureTs] = process.argv.slice(2)
const fail = reason => { throw Error(reason) }
const full = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x)
const env = {
  PATH:process.env.PATH, HOME:join(sandbox ?? '.', 'home'), LC_ALL:'C',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',
  GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',
}
const cwd=resolve(objects ?? '.')
const run=(program,args,options={})=>execFileSync(program,args,{cwd,encoding:'utf8',env,timeout:12000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],...options})
const git=(...args)=>run('git',['-c','core.hooksPath=/dev/null',...args]).trimEnd()
const trusted=(sha,path)=>{
  const item=git('ls-tree',sha,'--',path)
  if (!item.startsWith('100644 blob ') && !item.startsWith('100755 blob ')) fail('missing reviewed tool or policy')
  return run('git',['show',sha+':'+path])
}
function eventPins(){
 if(!full(boot)||lstatSync(eventFile).size>2*1024*1024) fail('invalid binding')
 const e=JSON.parse(readFileSync(eventFile,'utf8')), p=e.pull_request
 if(e.repository?.id!==1288615110||p?.base?.repo?.id!==1288615110||p.base.ref!=='main'||
    !['opened','synchronize','reopened'].includes(e.action)||!Number.isSafeInteger(p.number)||p.number<1||
    e.number!==p.number||!full(p.head?.sha)||!full(p.base?.sha)) fail('invalid GitHub event')
 return { n:p.number, head:p.head.sha, eventBase:p.base.sha }
}
function prepareTs(lock, dir) {
 const ts=lock.packages?.['node_modules/typescript']
 if(ts?.version!=='5.9.3'||ts.resolved!=='https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz'||
    ts.integrity!=='sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=='||
    ts.dependencies||ts.optionalDependencies||ts.hasInstallScript) fail('reviewed TypeScript pin changed')
 const pkg={name:'dazl-literal-audit-tools',version:'1.0.0',private:true,dependencies:{typescript:ts.version}}
 writeFileSync(join(dir,'package.json'),JSON.stringify(pkg),{flag:'wx'})
 if(fixtureTs){
   // Allowed only from the explicit local fixture CLI, never the Actions command.
   if(JSON.parse(readFileSync(join(fixtureTs,'package.json'),'utf8')).version!==ts.version) fail('wrong offline fixture compiler')
   mkdirSync(join(dir,'node_modules'));symlinkSync(resolve(fixtureTs),join(dir,'node_modules/typescript'),'dir')
 } else {
   writeFileSync(join(dir,'package-lock.json'),JSON.stringify({...pkg,lockfileVersion:3,requires:true,packages:{'':pkg,'node_modules/typescript':{version:ts.version,resolved:ts.resolved,integrity:ts.integrity}}}),{flag:'wx'})
   writeFileSync(join(dir,'empty-global-npmrc'),'')
   writeFileSync(join(dir,'empty-user-npmrc'),'')
   run('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--no-update-notifier','--fetch-retries=0','--registry=https://registry.npmjs.org/','--userconfig='+join(dir,'empty-user-npmrc'),'--globalconfig='+join(dir,'empty-global-npmrc')],{cwd:dir,timeout:20000})
 }
}
try{
 const {n,head,eventBase}=eventPins()
 if(git('rev-parse','--is-bare-repository')!=='true') fail('object-only checkout required')
 const main=git('rev-parse','--verify','refs/remotes/trusted/main^{commit}')
 const reportedHead=git('rev-parse','--verify',`refs/pull/${n}/head^{commit}`)
 const merge=git('rev-parse','--verify',`refs/pull/${n}/merge^{commit}`)
 if(main!==boot||reportedHead!==head||!full(merge)) fail('event refs drifted')
 mkdirSync(sandbox,{mode:0o700})
 mkdirSync(env.HOME,{mode:0o700})
 mkdirSync(join(sandbox,'.github','scripts'),{recursive:true})
 mkdirSync(join(sandbox,'web'))
 const publish=(name,body)=>writeFileSync(join(sandbox,name),body,{flag:'wx'})
 const policy=JSON.parse(trusted(main,'.github/policy/production-literals.json'))
 if(policy?.version!==1) fail('no main-reviewed literal policy')
 const verifier='.github/scripts/pr-merge-base.mjs'
 const scanner='.github/scripts/production-literals.mjs'
 publish(verifier,trusted(main,verifier)); publish(scanner,trusted(main,scanner))
 // This detached HEAD is only a pointer in the bare object store; no candidate file is ever checked out.
 git('update-ref','--no-deref','HEAD',merge)
 const selected=run(process.execPath,[join(sandbox,verifier),merge,head,eventBase]).trim()
 if(selected!==main) fail('first parent is not protected policy base')
 prepareTs(JSON.parse(trusted(main,'web/package-lock.json')),join(sandbox,'web'))
 const result=spawnSync(process.execPath,[join(sandbox,scanner),main,merge],{cwd,env,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']})
 if(result.error||![0,1].includes(result.status)) fail('scanner unavailable')
 const rows=JSON.parse(result.stdout)
 if(!Array.isArray(rows)) fail('invalid scanner receipt')
 const findings=rows.filter(row=>!row.receipt).length
 if(Boolean(findings)!==(result.status===1)) fail('inconsistent scanner receipt')
 console.log(`### Production literal advisory (not required)\n\nProtected base: ${main}\n\nPR head: ${head}\n\nTest merge: ${merge}\n\nUnapproved findings: ${findings}. Reviewed exceptions: ${rows.length-findings}.\n`)
 process.exitCode=result.status
} catch {
 // No git stderr, PR strings, file contents, or credentials in a public log/summary.
 console.log('### Production literal advisory unavailable\n\nThe exact refs, trusted policy/toolchain or bounded inspection could not be verified. No pass recorded.\n')
 process.exitCode=2
}
