import type { Env } from "./env";
import { isPlan, type Plan } from "./plans";

// Stripe-Signature verification: HMAC-SHA256 over `${t}.${payload}`, with a
// replay tolerance window. Any matching v1 signature is accepted.
export async function verifyStripeSignature(
  payload: string, header: string | null, secret: string, nowMs = Date.now(), toleranceSec = 300
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const timestamp = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSec) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

export async function setTenantPlan(db: D1Database, tenantId: string, plan: Plan): Promise<boolean> {
  const result = await db.prepare("UPDATE tenants SET plan = ? WHERE tenant_id = ?").bind(plan, tenantId).run();
  return result.meta.changes > 0;
}

// Create a Stripe Checkout session for the pro plan. client_reference_id
// carries the tenant id back to the webhook.
export async function createCheckoutSession(env: Env, tenantId: string, returnUrl: string): Promise<string> {
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_PRO ?? "",
    "line_items[0][quantity]": "1",
    client_reference_id: tenantId,
    "subscription_data[metadata][tenant_id]": tenantId,
    success_url: returnUrl,
    cancel_url: returnUrl,
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) throw new Error(`stripe ${response.status}`);
  const data = await response.json<{ url?: string }>();
  if (!data.url) throw new Error("stripe: no checkout url");
  return data.url;
}

interface StripeEvent {
  type: string;
  data: { object: { client_reference_id?: string; customer?: string; metadata?: { tenant_id?: string } } };
}

// Apply a verified Stripe event to tenant plans. Returns whether anything changed.
export async function applyStripeEvent(db: D1Database, event: StripeEvent): Promise<boolean> {
  const object = event.data?.object ?? {};
  const tenantId = object.client_reference_id ?? object.metadata?.tenant_id;
  if (!tenantId) return false;

  if (event.type === "checkout.session.completed") {
    if (object.customer) {
      await db.prepare("UPDATE tenants SET stripe_customer_id = ? WHERE tenant_id = ?").bind(object.customer, tenantId).run();
    }
    return setTenantPlan(db, tenantId, "pro");
  }
  if (event.type === "customer.subscription.deleted") {
    return setTenantPlan(db, tenantId, "free");
  }
  return false;
}

export { isPlan };
