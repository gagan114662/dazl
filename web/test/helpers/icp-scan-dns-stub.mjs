// Test-only stand-in for lib/net/scan-dns.ts in the icp-from-url route harness (#1463): the same answers as icp-dns-stub.mjs,
// so the real SSRF guard runs ('private.example' is private, every other host public) with no network.
import { lookup } from './icp-dns-stub.mjs'
export const SCAN_DNS_CONCURRENCY = 16
export async function scanLookupAll(hostname) { return lookup(hostname, { all: true }) }
export function scanLookupCb(hostname, cb) { scanLookupAll(hostname).then(a => cb(null, a), e => cb(e, [])) }
export function setScanDnsServersForTest() {}
