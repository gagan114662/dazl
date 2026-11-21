# #1436 signed shell telemetry: 937565d local candidate

A diagnostic receipt is only issued for signed top-level document GETs on /app, /app/business or /app/plays. The trusted server staging marker enables by default there; production stays off unless separately approved/configured. Server opt-out: DAZL_SIGNED_SHELL_TIMING=0. No staging or production environment has been changed.

Read staging app service stdout (dazl-staging.service journal), scoped to a narrow UTC interval and type=signed_shell_timing plus the server's response request_id. Do not export the Server-Timing receipt, cookies, asset names, URLs, body, profiles, or entire journal.

- proxy_auth.duration_ms: awaited auth check at the proxy before HTML, includes store initialization when first used.
- layout_auth.duration_ms: awaited shared layout auth check after cookie/header retrieval, not TTFB/full render time.
- browser_document.ttfb_ms: Navigation Timing responseStart minus requestStart. auth_marker_ms is time since navigation start until the streamed authenticated marker is outside a hidden segment, not full hydration or a loaded business profile.
- js_failed/css_failed: bounded number of observed startup errors for same-origin Next resources; no URLs/error text are sent. No browser observation if the document head never loads, metric stripped, session expired or telemetry itself fails. Later in-tab loads are outside this initial navigation probe.
- sqlite only classifies observed SQLITE_BUSY/SQLITE_LOCKED exception codes. It does not establish locks resolved during SQLite's busy wait.

No reproduced old 25–60s stall or root-cause fix is claimed. No auth/redirect or profile/spend policy change.
