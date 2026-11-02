/**
 * ============================================================================
 * MODEL GOVERNOR & TOKENMAXXING ENGINE
 * ============================================================================
 * Manages model routing, cost tracking, token telemetry, and proactive
 * benchmarking of free/OAuth tiers across providers.
 */

export interface ModelEntry {
  id: string;
  provider: string;
  modelName: string;
  category: "fast_classification" | "general_reasoning" | "deep_audit" | "coding";
  tier: "FREE_TIER" | "OAUTH" | "PAID";
  inputCostPer1M: number;
  outputCostPer1M: number;
  contextWindow: number;
  avgLatencyMs: number;
  tokensPerSec: number;
  qualityScore: number;
  status: "active" | "degraded" | "rate_limited";
  lastBenchmarkedAt: number;
}

export interface LlmUsageEvent {
  id: string;
  podId: string;
  taskId?: string;
  provider: string;
  modelId: string;
  tier: "FREE_TIER" | "OAUTH" | "PAID";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  savedUsd: number;
  latencyMs: number;
  status: string;
  createdAt: number;
}

// Baseline cost for comparison (e.g. GPT-4o @ $5.00/1M tokens avg)
const BASELINE_COST_PER_TOKEN = 0.000005;

export async function getModelCatalog(db: D1Database): Promise<ModelEntry[]> {
  const { results } = await db
    .prepare("SELECT * FROM model_catalog ORDER BY quality_score DESC")
    .all<any>();

  return (results || []).map((r) => ({
    id: r.id,
    provider: r.provider,
    modelName: r.model_name,
    category: r.category,
    tier: r.tier,
    inputCostPer1M: r.input_cost_per_1m,
    outputCostPer1M: r.output_cost_per_1m,
    contextWindow: r.context_window,
    avgLatencyMs: r.avg_latency_ms,
    tokensPerSec: r.tokens_per_sec,
    qualityScore: r.quality_score,
    status: r.status,
    lastBenchmarkedAt: r.last_benchmarked_at,
  }));
}

export async function resolveOptimalModel(
  db: D1Database,
  category: string = "general_reasoning",
  preferFree: boolean = true
): Promise<ModelEntry | null> {
  let query = "SELECT * FROM model_catalog WHERE status = 'active'";
  const params: any[] = [];

  if (category) {
    query += " AND category = ?";
    params.push(category);
  }

  if (preferFree) {
    // Sort Free/OAuth models first, then by tokens/sec descending
    query += " ORDER BY CASE WHEN tier IN ('FREE_TIER', 'OAUTH') THEN 0 ELSE 1 END ASC, tokens_per_sec DESC";
  } else {
    query += " ORDER BY quality_score DESC";
  }

  query += " LIMIT 1";

  const row = await db.prepare(query).bind(...params).first<any>();
  if (!row) return null;

  return {
    id: row.id,
    provider: row.provider,
    modelName: row.model_name,
    category: row.category,
    tier: row.tier,
    inputCostPer1M: row.input_cost_per_1m,
    outputCostPer1M: row.output_cost_per_1m,
    contextWindow: row.context_window,
    avgLatencyMs: row.avg_latency_ms,
    tokensPerSec: row.tokens_per_sec,
    qualityScore: row.quality_score,
    status: row.status,
    lastBenchmarkedAt: row.last_benchmarked_at,
  };
}

export async function recordUsage(
  db: D1Database,
  usage: {
    podId: string;
    taskId?: string;
    provider: string;
    modelId: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    tier?: "FREE_TIER" | "OAUTH" | "PAID";
    actualCost?: number;
  }
): Promise<LlmUsageEvent> {
  const now = Date.now();
  const id = `use_${now}_${Math.random().toString(36).slice(2, 7)}`;
  const totalTokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);

  // Look up model pricing
  const modelRow = await db
    .prepare("SELECT tier, input_cost_per_1m, output_cost_per_1m FROM model_catalog WHERE id = ? OR model_name = ?")
    .bind(usage.modelId, usage.modelId)
    .first<any>();

  const tier = usage.tier || (modelRow ? modelRow.tier : "PAID");
  let costUsd = usage.actualCost ?? 0.0;

  if (usage.actualCost === undefined && modelRow) {
    const inputCost = (usage.promptTokens / 1_000_000) * modelRow.input_cost_per_1m;
    const outputCost = (usage.completionTokens / 1_000_000) * modelRow.output_cost_per_1m;
    costUsd = inputCost + outputCost;
  }

  // TokenMaxxing Savings Calculation: What would this have cost on flagship GPT-4o?
  const baselineCost = totalTokens * BASELINE_COST_PER_TOKEN;
  const savedUsd = Math.max(0, baselineCost - costUsd);

  const event: LlmUsageEvent = {
    id,
    podId: usage.podId,
    taskId: usage.taskId,
    provider: usage.provider,
    modelId: usage.modelId,
    tier,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens,
    costUsd: parseFloat(costUsd.toFixed(6)),
    savedUsd: parseFloat(savedUsd.toFixed(6)),
    latencyMs: usage.latencyMs,
    status: "success",
    createdAt: now,
  };

  await db
    .prepare(
      `INSERT INTO llm_usage_events (
        id, pod_id, task_id, provider, model_id, tier, prompt_tokens, completion_tokens, total_tokens, cost_usd, saved_usd, latency_ms, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)`
    )
    .bind(
      event.id,
      event.podId,
      event.taskId || null,
      event.provider,
      event.modelId,
      event.tier,
      event.promptTokens,
      event.completionTokens,
      event.totalTokens,
      event.costUsd,
      event.savedUsd,
      event.latencyMs,
      event.createdAt
    )
    .run();

  return event;
}

export async function getTelemetryStats(db: D1Database): Promise<{
  totalTokens: number;
  totalCostUsd: number;
  totalSavedUsd: number;
  freeTierPercentage: number;
  eventsCount: number;
  topProviders: { provider: string; tokens: number; cost: number }[];
  recentEvents: LlmUsageEvent[];
}> {
  const totals = await db
    .prepare(`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(saved_usd), 0) as total_saved,
        COALESCE(SUM(CASE WHEN tier IN ('FREE_TIER', 'OAUTH') THEN total_tokens ELSE 0 END), 0) as free_tokens
      FROM llm_usage_events
    `)
    .first<any>();

  const totalTokens = totals?.total_tokens || 0;
  const freeTokens = totals?.free_tokens || 0;
  const freeTierPercentage = totalTokens > 0 ? (freeTokens / totalTokens) * 100 : 100;

  const { results: providerRows } = await db
    .prepare(`
      SELECT provider, SUM(total_tokens) as tokens, SUM(cost_usd) as cost
      FROM llm_usage_events
      GROUP BY provider
      ORDER BY tokens DESC
    `)
    .all<any>();

  const { results: recentRows } = await db
    .prepare("SELECT * FROM llm_usage_events ORDER BY created_at DESC LIMIT 20")
    .all<any>();

  const recentEvents: LlmUsageEvent[] = (recentRows || []).map((r) => ({
    id: r.id,
    podId: r.pod_id,
    taskId: r.task_id,
    provider: r.provider,
    modelId: r.model_id,
    tier: r.tier,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    costUsd: r.cost_usd,
    savedUsd: r.saved_usd,
    latencyMs: r.latency_ms,
    status: r.status,
    createdAt: r.created_at,
  }));

  return {
    totalTokens,
    totalCostUsd: parseFloat((totals?.total_cost || 0).toFixed(4)),
    totalSavedUsd: parseFloat((totals?.total_saved || 0).toFixed(4)),
    freeTierPercentage: parseFloat(freeTierPercentage.toFixed(1)),
    eventsCount: totals?.count || 0,
    topProviders: (providerRows || []).map((p) => ({
      provider: p.provider,
      tokens: p.tokens,
      cost: parseFloat((p.cost || 0).toFixed(4)),
    })),
    recentEvents,
  };
}
