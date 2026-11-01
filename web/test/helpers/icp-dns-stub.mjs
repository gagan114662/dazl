// Test-only DNS stub for the icp-from-url route harness. Every host resolves to a public IP so the SSRF
// guard passes; 'private.example' resolves to a private range so the not_public refusal runs through the real guard.
export async function lookup(hostname, options) {
  const addr = hostname === 'private.example' ? '10.0.0.9' : '93.184.216.34'
  if (options && options.all) return [{ address: addr, family: 4 }]
  return { address: addr, family: 4 }
}
