import './net-fence.ts'
if (!process.env.DB_PATH?.includes('/dazl-app-shell-timing-')) throw Error('Use an isolated shell timing fixture database')
process.env.DAZL_MASTER_KEY = Buffer.alloc(32,100).toString('base64')

// Only the dedicated populated worker fixture can reach this exact transport
// replay, and no authenticated external request leaves the loopback harness.
if (process.env.DAZL_SHELL_FIXTURE_PROVIDER === '1') {
  const { appendFileSync, existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const dir=dirname(process.env.DB_PATH)
  const fenced=globalThis.fetch
  let held=false
  globalThis.fetch=async (input,init)=>{
    const url=input instanceof Request?input.url:String(input)
    if(!['https://api.anthropic.com/v1/messages','https://api.anthropic.com/v1/messages/count_tokens'].includes(url))return fenced(input,init)
    const req=new Request(input,init)
    if(req.method!=='POST'||req.headers.get('x-api-key')!=='sk-ant-LOCAL-SHELL-TIMING-FIXTURE')throw Error('Unexpected provider request')
    const packet=await req.json()
    if(!Array.isArray(packet.messages))throw Error('Not a model request')
    if(url.endsWith('/count_tokens'))return Response.json({input_tokens:120})
    if(!held){
      if(!JSON.stringify(packet.messages).includes('Find laboratory operators'))throw Error('Unexpected worker job')
      held=true
      appendFileSync(join(dir,'fixture-provider-entered'),'one in-flight worker call\n')
      const until=Date.now()+70000
      while(!existsSync(join(dir,'release-fixture-provider'))&&Date.now()<until&&!req.signal.aborted)
        await new Promise(r=>setTimeout(r,50))
    }
    return Response.json({id:'msg_shell_fixture',model:'claude-sonnet-4-5',stop_reason:'end_turn',
      content:[{type:'text',text:JSON.stringify({summary:'Laboratory operators',who:['Operations director'],where:[],industries:[],sizes:[],signals:[],exclude:[]})}],
      usage:{input_tokens:5,output_tokens:5}})
  }
}
