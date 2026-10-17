import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

interface LockRow {
  holder: string;
  expiresAt: number;
}

// Per-tenant mutual exclusion for brain cycles.
//
// WHY: one tenant's employees share that tenant's single sandbox workspace
// (hydrate -> research -> persist). Two concurrent cycles for the same
// tenant would interleave hydrate/persist and overwrite each other's
// snapshots, so the whole research-reflect-persist cycle must be serialized
// per tenant. Tenants are independent (one lock instance per tenant via
// idFromName(tenantId)), so this never serializes ACROSS tenants.
//
// HOW: Durable Objects process incoming requests sequentially per instance,
// so acquire/release are atomic without transactions. Lock state lives in
// storage (survives DO eviction/restart). A TTL bounds how long a crashed
// holder can block its tenant: an expired lock is taken over by the next
// acquirer instead of deadlocking the tenant forever.
export class TenantLock extends DurableObject<Env> {
  async acquire(holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = await this.ctx.storage.get<LockRow | undefined>("lock");

    if (existing !== undefined && existing.holder !== holder && now < existing.expiresAt) {
      // Held by a different live holder — deny.
      return false;
    }

    // Free, expired (crashed holder), or already ours (refresh the TTL).
    await this.ctx.storage.put("lock", { holder, expiresAt: now + ttlMs });
    return true;
  }

  async release(holder: string): Promise<void> {
    const existing = await this.ctx.storage.get<LockRow | undefined>("lock");
    // Only the holder may clear the lock — a late release from a superseded
    // cycle (lock expired, another holder took over) must not free someone
    // else's lock.
    if (existing?.holder === holder) {
      await this.ctx.storage.delete("lock");
    }
  }
}
