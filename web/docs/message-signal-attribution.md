# Message and reply signal context

An approved outreach message gets a snapshot of its lead's existing signal text,
full signal-type JSON array, primary signal type, acquisition mode and evidence URL.
When the discovery ledger exists, its actual collector links are copied as a set.
Absent collector provenance stays NULL, never inferred from the evidence host.

The snapshot is made in the approval transaction. Editing and reapproving refreshes
it; changes to the lead after approval do not silently rewrite it. Historical
messages are not backfilled and remain without an approval-time snapshot.

New captured inbound messages store the root outreach_message_id from the exact
Gmail thread the reply reader was already inspecting. The reply read helper joins
that root to its approved context. This is a thread-level association, not proof
that a particular signal or sequence step caused a reply. Classification is
preserved: automatic replies and bounces are not silently counted as human replies.
No causal conversion metric, dashboard, extra inbox access or reply body storage is
added. The existing test marker is returned so test traffic can be excluded.

Both read helpers are tenant scoped. No recipient address or full email/reply body
is duplicated into the snapshot. Existing consent, approval and sending rules do
not change. The source ledger is optional for this slice: without it,
collectors_json is NULL.
