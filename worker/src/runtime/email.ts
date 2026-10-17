import type { Env } from "./env";

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function unsubscribeSecret(env: Env): string {
  return env.UNSUBSCRIBE_SECRET || env.DAZL_API_SECRET || "";
}

export async function signUnsubscribe(env: Env, tenantId: string, email: string): Promise<string> {
  return hmac(unsubscribeSecret(env), `unsub:${tenantId}:${email.toLowerCase()}`);
}

export async function verifyUnsubscribe(env: Env, tenantId: string, email: string, signature: string): Promise<boolean> {
  if (!unsubscribeSecret(env)) return false;
  const expected = await signUnsubscribe(env, tenantId, email);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function buildUnsubscribeUrl(env: Env, tenantId: string, email: string): Promise<string> {
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const signature = await signUnsubscribe(env, tenantId, email);
  return `${base}/unsubscribe?t=${encodeURIComponent(tenantId)}&e=${encodeURIComponent(email)}&s=${signature}`;
}

export interface OutboundEmail { to: string; subject: string; text: string }
export type EmailSender = (env: Env, email: OutboundEmail) => Promise<void>;

export const resendSender: EmailSender = async (env, email) => {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text }),
  });
  if (!response.ok) throw new Error(`resend ${response.status}`);
};

let activeSender: EmailSender = resendSender;
export function setEmailSenderForTests(sender: EmailSender | null): void {
  activeSender = sender ?? resendSender;
}
export function getEmailSender(): EmailSender { return activeSender; }

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM && env.PUBLIC_BASE_URL);
}

// Footer with identity + one-click unsubscribe (CAN-SPAM).
export function complianceFooter(senderName: string, postalAddress: string, unsubscribeUrl: string): string {
  return `\n\n--\n${senderName}\n${postalAddress}\nUnsubscribe: ${unsubscribeUrl}`;
}
