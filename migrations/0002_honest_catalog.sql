-- factory-hub#78: honest model catalog.
-- Measured fields become nullable (NULL = unmeasured). Every hand-typed 2024 benchmark is dropped.
-- Seed rows are demoted to lifecycle 'candidate' with source 'seed-2024'; nothing is routable until measured.
CREATE TABLE IF NOT EXISTS model_catalog_v2 (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  family TEXT,
  category TEXT NOT NULL CHECK (category IN ('fast_classification', 'general_reasoning', 'deep_audit', 'coding')),
  tier TEXT NOT NULL CHECK (tier IN ('FREE_TIER', 'OAUTH', 'PAID')),
  input_cost_per_1m REAL,
  output_cost_per_1m REAL,
  context_window INTEGER,
  avg_latency_ms INTEGER,
  tokens_per_sec INTEGER,
  quality_score REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'rate_limited')),
  last_benchmarked_at INTEGER,
  lifecycle TEXT NOT NULL DEFAULT 'candidate' CHECK (lifecycle IN ('candidate', 'qualified', 'retired')),
  source TEXT NOT NULL DEFAULT 'discovered',
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  probe_runs INTEGER NOT NULL DEFAULT 0,
  probe_passes INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at INTEGER
);

INSERT OR IGNORE INTO model_catalog_v2 (id, provider, model_name, category, tier, input_cost_per_1m, output_cost_per_1m, context_window, status, lifecycle, source)
SELECT id, provider, model_name, category, tier, input_cost_per_1m, output_cost_per_1m, context_window, 'active', 'candidate', 'seed-2024'
FROM model_catalog;

DROP TABLE model_catalog;
ALTER TABLE model_catalog_v2 RENAME TO model_catalog;
CREATE INDEX IF NOT EXISTS idx_catalog_route ON model_catalog(category, lifecycle);

CREATE TABLE IF NOT EXISTS model_probes (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  tokens_per_sec REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probes_model ON model_probes(model_id, created_at DESC);
