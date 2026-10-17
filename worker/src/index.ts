export { EmployeeState } from "./runtime/employee-state";
export { EmployeeCycle } from "./runtime/employee-cycle-workflow";
export { TenantLock } from "./runtime/tenant-lock";

import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

// The brain container sleeps 45s after it goes idle, overriding the SDK default
// of 10 minutes. A cycle does ~1-2 min of active work; 45s of idle buffer is
// ample. Container memory + disk bill for the ENTIRE time the instance is alive
// (not just active compute), so the default 10-min idle tail was ~87% pure
// waste — this cuts container cost ~75-80% with zero change to behavior.
export class Sandbox extends BaseSandbox {
  sleepAfter = "45s";
}

/**
 * Clicky Proxy Worker
 *
 * Proxies requests to Claude and ElevenLabs APIs so the app never
 * ships with raw API keys. Keys are stored as Cloudflare secrets.
 *
 * Routes:
 *   POST /chat  → Anthropic Messages API (streaming)
 *   POST /tts   → ElevenLabs TTS API
 *
 * Also hosts the dazl runtime spine routes (employee spawn/inspect) and
 * the cron-driven scheduled handler that wakes every known employee.
 */

import type { Env } from "./runtime/env";
import {
  handleSpawnEmployee,
  handleInspectEmployee,
  wakeAllEmployees,
  handleCreateTenant,
  handleMintTenantKey,
  handleRevokeKey,
  handleSpawnEmployeeV1,
  handleListEmployeesV1,
  handleInspectEmployeeV1,
} from "./runtime/routes";
import { authenticateRequest } from "./runtime/auth";
import { handleProductRoute, handleSetPlan, handleStripeWebhook, handleUnsubscribe } from "./runtime/product-routes";
import { dashboardResponse } from "./runtime/dashboard";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // --- public, unauthenticated-by-bearer endpoints ---
    // Dashboard shell (holds no data; every API call it makes needs a key).
    if ((url.pathname === "/app" || url.pathname === "/app/") && request.method === "GET") {
      return dashboardResponse();
    }
    // Recipient-facing unsubscribe link (authenticated by HMAC signature).
    if (url.pathname === "/unsubscribe" && request.method === "GET") {
      return await handleUnsubscribe(url, env);
    }

    // --- dazl multitenant API (v1) ---
    // Tenant context is derived from the credential (API key or admin
    // secret), never from a tenantId the request supplies.
    if (url.pathname.startsWith("/v1/")) {
      try {
        const auth = await authenticateRequest(request, env);

        if (url.pathname === "/v1/tenants" && request.method === "POST") {
          return await handleCreateTenant(request, env);
        }
        const mintKeyMatch = url.pathname.match(/^\/v1\/tenants\/([a-zA-Z0-9_-]+)\/api-keys$/);
        if (mintKeyMatch && request.method === "POST") {
          return await handleMintTenantKey(request, env, mintKeyMatch[1]);
        }
        const revokeKeyMatch = url.pathname.match(/^\/v1\/api-keys\/([a-zA-Z0-9_-]+)$/);
        if (revokeKeyMatch && request.method === "DELETE") {
          return await handleRevokeKey(request, env, revokeKeyMatch[1]);
        }

        // Stripe calls this without a bearer; it is authenticated by signature.
        if (url.pathname === "/v1/billing/webhook" && request.method === "POST") {
          return await handleStripeWebhook(request, env);
        }
        const planMatch = url.pathname.match(/^\/v1\/tenants\/([a-zA-Z0-9_-]+)\/plan$/);
        if (planMatch && request.method === "PUT") {
          if (!auth?.isAdmin) {
            return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
          }
          return await handleSetPlan(request, env, planMatch[1]);
        }

        if (!auth) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        const productResponse = await handleProductRoute(request, env, auth, url);
        if (productResponse) return productResponse;

        if (url.pathname === "/v1/employees" && request.method === "POST") {
          return await handleSpawnEmployeeV1(request, env, auth);
        }
        if (url.pathname === "/v1/employees" && request.method === "GET") {
          return await handleListEmployeesV1(env, auth);
        }
        const inspectV1Match = url.pathname.match(/^\/v1\/employees\/([a-z0-9-]+)$/);
        if (inspectV1Match && request.method === "GET") {
          return await handleInspectEmployeeV1(inspectV1Match[1], env, auth);
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        // Generic 500 — details go to logs only (see errorResponse in
        // routes.ts for why echoing String(error) leaks internals).
        console.error("[/v1] Unhandled error:", error);
        return new Response(JSON.stringify({ error: "internal error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // --- dazl runtime routes (LEGACY, default tenant; deprecated in favor of /v1) ---
    if (url.pathname === "/employees" && request.method === "POST") {
      return await handleSpawnEmployee(request, env);
    }
    const inspectMatch = url.pathname.match(/^\/employees\/([a-z0-9-]+)$/);
    if (inspectMatch && request.method === "GET") {
      return await handleInspectEmployee(inspectMatch[1], env, request);
    }

    // --- existing proxy routes (POST only) ---
    // Scoped to the three known proxy paths so an unmatched path (any method)
    // still falls through to the 404 below instead of being masked by 405.
    const isKnownProxyPath =
      url.pathname === "/chat" ||
      url.pathname === "/tts" ||
      url.pathname === "/transcribe-token";
    if (isKnownProxyPath) {
      // Optional auth: with PROXY_SHARED_SECRET set, the proxy routes require
      // it; unset (default), they stay open so the shipped Swift app — which
      // does not yet send an Authorization header on these routes — keeps
      // working. See env.ts.
      if (env.PROXY_SHARED_SECRET) {
        const authorizationHeader = request.headers.get("Authorization");
        if (authorizationHeader !== `Bearer ${env.PROXY_SHARED_SECRET}`) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      try {
        if (url.pathname === "/chat") return await handleChat(request, env);
        if (url.pathname === "/tts") return await handleTTS(request, env);
        if (url.pathname === "/transcribe-token") return await handleTranscribeToken(env);
      } catch (error) {
        console.error(`[${url.pathname}] Unhandled error:`, error);
        return new Response(JSON.stringify({ error: String(error) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await wakeAllEmployees(env);
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = await request.text();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/chat] Anthropic API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

async function handleTranscribeToken(env: Env): Promise<Response> {
  const response = await fetch(
    "https://streaming.assemblyai.com/v3/token?expires_in_seconds=480",
    {
      method: "GET",
      headers: {
        authorization: env.ASSEMBLYAI_API_KEY,
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/transcribe-token] AssemblyAI token error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  const data = await response.text();
  return new Response(data, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleTTS(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const voiceId = env.ELEVENLABS_VOICE_ID;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/tts] ElevenLabs API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    },
  });
}
