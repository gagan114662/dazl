// Standalone server-side settlement projection. No store, network, API key,
// eligibility, retry, model selection, logging or delivery dependency.
export const TARIFF = 'anthropic_first_party_sonnet55_usd_v1'
const MODEL = 'claude-sonnet-5-5'
const MAX_REPORTED = 10_000_000
const counts = ['web_search_requests','web_fetch_requests','code_execution_requests'] as const
type Reason = 'binding'|'provider_error'|'envelope'|'model'|'tier'|'geo'|'speed'|'tokens'|'cache'|'tools'|'cost'

export type BillingBinding = Readonly<{
  tariff: typeof TARIFF; model: typeof MODEL; provider:'anthropic'; api:'messages_2023-06-01'; currency:'USD'
  tier:'standard_only'; geo:'global'|'us'; cache:'uncached'|'documented_ttl'
  tool:'web_search_20260209'|'web_fetch_20260209'; caller:'code_execution_20260120'
  maxUses:number; maxOutput:number
}>
type Settled = Readonly<{
  outcome:'settled'; actualMicros:number
  searches:number; fetches:number; codeExecutions:number|null
  continuation:'none'; evidenceEligible:boolean
  stop:'end_turn'|'pause_turn'|'refusal'|'tool_error'|'truncated'|'provider_limit'|'other'
}>
type Uncertain = Readonly<{outcome:'uncertain'; reason:Reason; continuation:'none'; evidenceEligible:false}>

const obj=(v:unknown):Record<string,unknown>|null=>v!==null && typeof v==='object' && !Array.isArray(v)?v as Record<string,unknown>:null
const counter=(v:unknown):v is number=>typeof v==='number' && Number.isSafeInteger(v) && v>=0 && v<=MAX_REPORTED
const uncertain=(reason:Reason):Uncertain=>({outcome:'uncertain',reason,continuation:'none',evidenceEligible:false})

export function decodeDynamicSettlement(binding: BillingBinding | null, response: Readonly<{status:number; body:unknown}>): Settled|Uncertain {
  if(!binding || binding.tariff!==TARIFF || binding.model!==MODEL || binding.provider!=='anthropic' ||
    binding.api!=='messages_2023-06-01' || binding.currency!=='USD' || binding.tier!=='standard_only' ||
    (binding.geo!=='global'&&binding.geo!=='us') || (binding.cache!=='uncached'&&binding.cache!=='documented_ttl') ||
    binding.caller!=='code_execution_20260120' || !counter(binding.maxUses) || binding.maxUses<1)
    return uncertain('binding')
  const isSearch=binding.tool==='web_search_20260209'
  if(isSearch ? binding.maxUses>5 || binding.maxOutput!==3000 :
    binding.tool!=='web_fetch_20260209' || binding.maxUses!==1 || binding.maxOutput!==1400) return uncertain('binding')
  const msg=obj(response.body)
  // Documented HTTP error envelopes do not attest usage. Never infer zero.
  if(response.status!==200 || msg?.type==='error') return uncertain('provider_error')
  const usage=obj(msg?.usage)
  if(!msg || msg.type!=='message' || msg.role!=='assistant' || !usage) return uncertain('envelope')
  if(msg.model!==binding.model) return uncertain('model')
  if(usage.service_tier!=='standard') return uncertain('tier')
  if(usage.inference_geo!==binding.geo) return uncertain('geo')
  // SDK speed is optional. No fast mode was requested or priced on this binding;
  // an explicit nonstandard label is not normalized to the standard rate.
  if(usage.speed!=null && usage.speed!=='standard') return uncertain('speed')
  const input=usage.input_tokens, output=usage.output_tokens
  if(!counter(input)||!counter(output)) return uncertain('tokens')
  const tools=obj(usage.server_tool_use)
  if(!tools) return uncertain('tools')
  const searches=tools.web_search_requests, fetches=tools.web_fetch_requests
  const executionRecorded=Object.hasOwn(tools,'code_execution_requests')
  const executions=executionRecorded?tools.code_execution_requests:null
  if(!counter(searches)||!counter(fetches)|| (executionRecorded&&!counter(executions)) ||
     Object.entries(tools).some(([key,v])=>!(counts as readonly string[]).includes(key)&&v!==0)) return uncertain('tools')

  // Nullable/missing cache totals describe an uncached trusted request only
  // when there is no positive split. Meter known TTLs; never guess a split.
  const read=usage.cache_read_input_tokens??(binding.cache==='uncached'?0:null)
  const total=usage.cache_creation_input_tokens??(binding.cache==='uncached'?0:null)
  const split=usage.cache_creation==null?null:obj(usage.cache_creation)
  if(!counter(read)||!counter(total)||(usage.cache_creation!=null&&!split)) return uncertain('cache')
  const five=split?.ephemeral_5m_input_tokens??(total===0?0:null)
  const hour=split?.ephemeral_1h_input_tokens??(total===0?0:null)
  if(!counter(five)||!counter(hour)||five+hour!==total ||
    (split&&Object.entries(split).some(([k,v])=>!['ephemeral_5m_input_tokens','ephemeral_1h_input_tokens'].includes(k)&&v!==0)) ||
    (binding.cache==='uncached'&&(read!==0||total!==0))) return uncertain('cache')

  // Sonnet 5.5 standard list prices, USD. Token rates expressed in tenths of
  // one microdollar; US multiplier applies only to token charges. Search fee
  // is exact $0.01, fetch/bundled code add no tool fee. Round once, upwards.
  const tokenTenths=BigInt(input)*BigInt(20)+BigInt(output)*BigInt(100)+BigInt(read)+BigInt(five)*BigInt(25)+BigInt(hour)*BigInt(40)
  const numerator=tokenTenths*BigInt(binding.geo==='us'?11:10)+BigInt(searches)*BigInt(1_000_000)
  const micros=(numerator+BigInt(99))/BigInt(100)
  if(micros>BigInt(Number.MAX_SAFE_INTEGER)) return uncertain('cost')
  const over=output>binding.maxOutput||(isSearch?(searches>binding.maxUses||fetches!==0):(fetches>binding.maxUses||searches!==0))
  const content=Array.isArray(msg.content)?msg.content:null
  const toolError=content?.some(block=>{
    const entry=obj(block), cell=obj(entry?.content), error=cell?.type
    return typeof error==='string' && (
      error==='web_search_tool_result_error'||error==='web_fetch_tool_result_error'||error==='code_execution_tool_result_error'||
      error==='bash_code_execution_tool_result_error'||error==='text_editor_code_execution_tool_result_error'
    )
  })??false
  const rawStop=msg.stop_reason
  const stop: Settled['stop']=over?'provider_limit':rawStop==='refusal'?'refusal':
    rawStop==='pause_turn'?'pause_turn':toolError?'tool_error':
    rawStop==='max_tokens'||rawStop==='model_context_window_exceeded'?'truncated':
    rawStop==='end_turn'&&content?'end_turn':'other'
  // This is only permission to run the separate receipt/provenance parser.
  // A result block by itself is not URL, quote or lead evidence.
  const expectedBlock=isSearch?'web_search_tool_result':'web_fetch_tool_result'
  const hasExpectedBlock=content?.some(block=>obj(block)?.type===expectedBlock)??false
  return {outcome:'settled',actualMicros:Number(micros),searches,fetches,
    codeExecutions: counter(executions)?executions:null,stop,
    continuation:'none',evidenceEligible:stop==='end_turn'&&hasExpectedBlock&&(isSearch?searches>0:fetches>0)}
}
