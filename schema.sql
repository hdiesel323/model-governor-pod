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

CREATE TABLE IF NOT EXISTS model_catalog (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('fast_classification', 'general_reasoning', 'deep_audit', 'coding')),
  tier TEXT NOT NULL CHECK (tier IN ('FREE_TIER', 'OAUTH', 'PAID')),
  input_cost_per_1m REAL NOT NULL,
  output_cost_per_1m REAL NOT NULL,
  context_window INTEGER NOT NULL,
  avg_latency_ms INTEGER NOT NULL,
  tokens_per_sec INTEGER NOT NULL,
  quality_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'rate_limited')),
  last_benchmarked_at INTEGER NOT NULL
);

-- Seed High-Priority Free & TokenMaxxed Models
INSERT OR IGNORE INTO model_catalog (
  id, provider, model_name, category, tier, input_cost_per_1m, output_cost_per_1m, context_window, avg_latency_ms, tokens_per_sec, quality_score, status, last_benchmarked_at
) VALUES
  ('cf-llama-3-1-8b', 'cloudflare_ai', '@cf/meta/llama-3.1-8b-instruct', 'fast_classification', 'FREE_TIER', 0.00, 0.00, 131072, 85, 240, 88.5, 'active', 1730500000000),
  ('cerebras-llama-3-3-70b', 'cerebras', 'llama3.3-70b', 'general_reasoning', 'FREE_TIER', 0.00, 0.00, 131072, 120, 1400, 94.0, 'active', 1730500000000),
  ('openrouter-gemini-flash-free', 'openrouter', 'google/gemini-2.0-flash-exp:free', 'general_reasoning', 'FREE_TIER', 0.00, 0.00, 1048576, 210, 180, 92.5, 'active', 1730500000000),
  ('openrouter-deepseek-r1-free', 'openrouter', 'deepseek/deepseek-r1:free', 'deep_audit', 'FREE_TIER', 0.00, 0.00, 65536, 450, 95, 96.0, 'active', 1730500000000),
  ('fireworks-llama-3-3-70b', 'fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'general_reasoning', 'PAID', 0.90, 0.90, 131072, 180, 160, 94.5, 'active', 1730500000000),
  ('anthropic-claude-3-5-sonnet', 'anthropic', 'claude-3-5-sonnet-20241022', 'deep_audit', 'PAID', 3.00, 15.00, 200000, 850, 75, 99.0, 'active', 1730500000000);
