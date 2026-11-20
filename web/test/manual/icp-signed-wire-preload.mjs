// Load the standard secret/net fence before providing this sole fixture wire.
import '../helpers/net-fence.ts'
import { appendFileSync } from 'node:fs'
const db = process.env.DB_PATH
if (!db?.includes('/dazl-signed-icp-') || !process.env.DAZL_FIXTURE_WIRE?.startsWith(db.slice(0, db.lastIndexOf('/')) + '/')) {
  throw new Error('Use the signed ICP loopback fixture runner')
}
process.env.DAZL_MASTER_KEY = Buffer.alloc(32, 42).toString('base64')
const fenced = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== 'https://api.anthropic.com/v1/messages') return fenced(input, init)
  const req = new Request(input, init)
  if (req.method !== 'POST' || req.headers.get('x-api-key') !== 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') throw new Error('non-fixture Anthropic call')
  const body = await req.json()
  if (!Array.isArray(body.messages) || body.max_tokens !== 800) throw new Error('not an ICP request')
  appendFileSync(process.env.DAZL_FIXTURE_WIRE, 'synthetic Messages fixture\n')
  return Response.json({ id: 'msg_fixture', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: JSON.stringify({ summary:'Example laboratory founders in Europe', who:['Founder'],where:['Europe'],signals:['hiring'],exclude:[] }) }], usage:{ input_tokens:10, output_tokens:10 } })
}
