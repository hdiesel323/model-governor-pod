-- factory-hub#80: OAuth subscription models: device probing, quota awareness, subscription advisor

-- 1. Device provenance on probes
ALTER TABLE model_probes ADD COLUMN device TEXT;

-- 2. Quota awareness: track rate-limit and quota errors per OAuth/API provider
CREATE TABLE IF NOT EXISTS provider_quotas (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'rate_limited')),
  error TEXT,
  exhausted_at INTEGER,
  resets_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- 3. Subscription advisor: operator subscription pricing per family/provider
CREATE TABLE IF NOT EXISTS subscription_prices (
  family TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  monthly_price_usd REAL NOT NULL,
  notes TEXT,
  updated_at INTEGER NOT NULL
);

-- Seed standard baseline subscription costs entered by HD
INSERT OR IGNORE INTO subscription_prices (family, provider, monthly_price_usd, notes, updated_at) VALUES
  ('anthropic', 'anthropic', 20.00, 'Claude Code / Pro subscription', 1793696000000),
  ('openai', 'openai', 20.00, 'ChatGPT Plus / Codex subscription', 1793696000000),
  ('google', 'google', 20.00, 'Google One AI Premium / Antigravity', 1793696000000),
  ('xai', 'xai', 20.00, 'xAI Grok Premium', 1793696000000),
  ('zai', 'zai', 15.00, 'Zhipu GLM coding subscription', 1793696000000);
