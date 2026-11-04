-- factory-hub#78: repair after migration 0002 was re-applied on top of live data (2026-11-03).
-- The re-run relabeled every discovered row source='seed-2024', cleared family/first_seen/last_seen/model_created_at
-- and measurements; discovery then retired them all as "superseded seeds" on every run.
-- Rows whose id starts with 'openrouter:' can only have come from discovery (real 2024 seeds use other ids).

-- 1. restore provenance and lifecycle (0003's exclusions still apply)
UPDATE model_catalog SET source = 'discovered', status = 'active',
  lifecycle = CASE WHEN model_name LIKE '%:batch' OR model_name LIKE 'openrouter/%' OR model_name LIKE '%lyria%' THEN 'retired' ELSE 'candidate' END
WHERE id LIKE 'openrouter:%';

-- 2. restore family (needed for excludeFamily: NULL would bypass the auditor-family exclusion)
UPDATE model_catalog SET family = CASE lower(substr(model_name, 1, instr(model_name, '/') - 1))
    WHEN 'meta-llama' THEN 'meta' WHEN 'x-ai' THEN 'xai' WHEN 'mistralai' THEN 'mistral'
    ELSE lower(substr(model_name, 1, instr(model_name, '/') - 1)) END
WHERE id LIKE 'openrouter:%' AND instr(model_name, '/') > 0;

-- 3. rebuild measurements from the surviving raw probe history (only successful smoke runs count)
UPDATE model_catalog SET
  probe_runs   = (SELECT COUNT(*) FROM model_probes p WHERE p.model_id = model_catalog.id AND p.error IS NULL AND p.suite_version = 'smoke-2026-11-v1'),
  probe_passes = (SELECT COALESCE(SUM(passed), 0) FROM model_probes p WHERE p.model_id = model_catalog.id AND p.error IS NULL AND p.suite_version = 'smoke-2026-11-v1'),
  quality_score = (SELECT CASE WHEN SUM(total) > 0 THEN ROUND(100.0 * SUM(passed) / SUM(total), 1) END FROM model_probes p WHERE p.model_id = model_catalog.id AND p.error IS NULL AND p.suite_version = 'smoke-2026-11-v1'),
  avg_latency_ms = (SELECT CAST(AVG(latency_ms) AS INTEGER) FROM model_probes p WHERE p.model_id = model_catalog.id AND p.error IS NULL AND p.suite_version = 'smoke-2026-11-v1'),
  tokens_per_sec = (SELECT CAST(AVG(tokens_per_sec) AS INTEGER) FROM model_probes p WHERE p.model_id = model_catalog.id AND p.error IS NULL AND p.suite_version = 'smoke-2026-11-v1'),
  last_benchmarked_at = (SELECT MAX(created_at) FROM model_probes p WHERE p.model_id = model_catalog.id)
WHERE id LIKE 'openrouter:%';

-- 4. first_seen_at was lost; the earliest probe (or now) is the best honest lower bound
UPDATE model_catalog SET first_seen_at = COALESCE(first_seen_at, (SELECT MIN(created_at) FROM model_probes p WHERE p.model_id = model_catalog.id), CAST(strftime('%s','now') AS INTEGER) * 1000)
WHERE id LIKE 'openrouter:%';

-- 5. migration tracking: wrangler's d1_migrations table, so no file can ever be applied twice again
CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0002_honest_catalog.sql'), ('0003_model_created_at.sql'), ('0004_oauth_device_and_quotas.sql'), ('0005_repair_reapplied_0002.sql');
