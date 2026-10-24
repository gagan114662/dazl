// TEST-ONLY transport seam, outside shipped code. Maps the fixture hostnames named in `pages`
// onto a local loopback HTTP server so the REAL crawler, route and stores run unchanged. Any other
// https host still goes to the real request function (and the net fence, in tests).
import http from 'node:http'
import https from 'node:https'

export type Pages = Record<string, Record<string, string>> // host -> path -> html ('' = 404)
export async function installFixtureTransport(pages: Pages): Promise<{ close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    const host = String(req.headers['x-fixture-host'] ?? '')
    hits.push(`${host}${req.url}`)
    const body = pages[host]?.[String(req.url).split('?')[0]]
    if (body === undefined) { res.writeHead(404, { 'content-type': 'text/html' }); res.end(''); return }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(body)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const orig = https.request
  ;(https as unknown as { request: unknown }).request = ((url: URL, opts: http.RequestOptions, cb: (r: http.IncomingMessage) => void) => {
    if (url instanceof URL && url.hostname in pages) {
      const port = (server.address() as { port: number }).port
      return http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, method: 'GET', headers: { ...(opts.headers ?? {}), 'x-fixture-host': url.hostname }, timeout: opts.timeout }, cb)
    }
    return (orig as unknown as (...a: unknown[]) => unknown)(url, opts, cb)
  }) as never
  return { hits, close: () => new Promise(r => { (https as unknown as { request: unknown }).request = orig; server.close(() => r()) }) }
}
