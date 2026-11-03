-- ============================================================================
-- Factory Pod Base Template — Dual Engine Schema (D1 / SQLite WAL)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pod_info (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tincan_messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  topic TEXT NOT NULL,
  from_pod TEXT NOT NULL,
  to_pod TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('pending', 'delivered', 'acknowledged')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pod_tincan_topic ON tincan_messages(topic);

-- ============================================================================
-- MODEL GOVERNOR & TOKENMAXXING SCHEMA
-- ============================================================================

CREATE TABLE IF NOT EXISTS llm_usage_events (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  task_id TEXT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('FREE_TIER', 'OAUTH', 'PAID')),
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  saved_usd REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_pod ON llm_usage_events(pod_id);
CREATE INDEX IF NOT EXISTS idx_usage_tier ON llm_usage_events(tier);
CREATE INDEX IF NOT EXISTS idx_usage_created ON llm_usage_events(created_at DESC);

-- factory-hub#78: no hand-typed seed. The catalog is filled by live discovery and measured by probes.
CREATE TABLE IF NOT EXISTS model_catalog (
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

