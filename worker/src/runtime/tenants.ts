// Tenant + API-key data access. The full API key is returned to the caller
// exactly once at mint time; only its SHA-256 digest is ever stored, so a
// database leak does not leak usable credentials.

export interface TenantRow {
  tenantId: string;
  name: string;
  createdAt: number;
}

export interface ApiKeyIssuance {
  keyId: string;
  apiKey: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binaryString = "";
  for (const byte of bytes) {
    binaryString += String.fromCharCode(byte);
  }
  return btoa(binaryString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// `dazl_` + 32 random bytes (base64url, ~43 chars). The prefix makes keys
// identifiable in logs and lets secret scanners recognize them; 256 bits of
// entropy makes brute-forcing the digest infeasible.
export function generateApiKey(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return `dazl_${bytesToBase64Url(randomBytes)}`;
}

// The stored form of a key: hex-encoded SHA-256 of the full key. Hashing
// (rather than encrypting) is deliberate — nothing ever needs to recover the
// key from storage; if it is lost, mint a new one.
export async function hashApiKey(apiKey: string): Promise<string> {
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return bytesToHex(new Uint8Array(digestBytes));
}

function generateTenantId(): string {
  // Distinct prefix from key ids so ids are self-describing in logs.
  return `t_${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
}

function generateKeyId(): string {
  return `k_${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
}

export async function createTenant(db: D1Database, name: string): Promise<TenantRow> {
  const tenantRow: TenantRow = {
    tenantId: generateTenantId(),
    name,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await db
    .prepare("INSERT INTO tenants (tenant_id, name) VALUES (?, ?)")
    .bind(tenantRow.tenantId, tenantRow.name)
    .run();
  return tenantRow;
}

export async function tenantExists(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT tenant_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ tenant_id: string }>();
  return row !== null;
}

// Mint a new API key for a tenant. Returns the key material once; the caller
// must surface it to the tenant operator in the same response and never
// persist it.
export async function mintApiKey(db: D1Database, tenantId: string): Promise<ApiKeyIssuance> {
  const apiKey = generateApiKey();
  const keyDigest = await hashApiKey(apiKey);
  const keyId = generateKeyId();
  // key_preview: first 8 + last 4 characters, enough for an operator to tell
  // two of a tenant's keys apart in logs without holding the key.
  const keyPreview = `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`;
  await db
    .prepare("INSERT INTO api_keys (key_id, tenant_id, key_digest, key_preview) VALUES (?, ?, ?, ?)")
    .bind(keyId, tenantId, keyDigest, keyPreview)
    .run();
  return { keyId, apiKey };
}

// Resolve an API key to its tenant. Returns null for unknown, malformed, or
// revoked keys — callers must treat all three identically (401) so probing
// with candidate keys reveals nothing about which are near-misses.
export async function findActiveTenantIdByApiKey(db: D1Database, apiKey: string): Promise<string | null> {
  const keyDigest = await hashApiKey(apiKey);
  const row = await db
    .prepare(
      "SELECT tenant_id FROM api_keys WHERE key_digest = ? AND revoked_at IS NULL"
    )
    .bind(keyDigest)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

// Revoke a key by id. Returns false when the key id does not exist (so the
// DELETE route can 404 rather than silently succeeding).
export async function revokeApiKey(db: D1Database, keyId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL")
    .bind(Math.floor(Date.now() / 1000), keyId)
    .run();
  return result.meta.changes > 0;
}
