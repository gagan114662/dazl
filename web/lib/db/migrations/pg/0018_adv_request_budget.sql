-- One atomic request budget per tenant and connector shared by every consumer of the same upstream (lib/advanced/request-budget.ts, #192).
CREATE TABLE adv_budget_lock (tenant_id TEXT NOT NULL, connector TEXT NOT NULL, n BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, connector));
CREATE TABLE adv_requests (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connector TEXT NOT NULL, at BIGINT NOT NULL, consumer TEXT NOT NULL);
CREATE INDEX adv_requests_window ON adv_requests (tenant_id, connector, at);
