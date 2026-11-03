// Live model discovery (factory-hub#78). Pulls real catalogs; never invents numbers.
// Sources: OpenRouter GET /api/v1/models (public: ids, real prices, context, created date),
//          OrcaRouter GET /v1/models (when ORCAROUTER_API_KEY is set: ids only; prices unknown -> NULL).
// New ids become lifecycle 'candidate' with first_seen_at. Ids missing from their source for 7 days are retired.

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscoveredModel {
  id: string;
  provider: string;
  modelName: string;
  family: string;
  category: "general_reasoning" | "coding";
  tier: "FREE_TIER" | "PAID";
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  contextWindow: number | null;
  createdAt: number | null;
}

/** Not a chat model we can probe: routers, batch-API variants, non-text in/out (music, image, embeddings). */
export function excludedReason(m: any): string | null {
  const id = String(m?.id ?? "");
  if (id.startsWith("openrouter/")) return "router";
  if (id.endsWith(":batch")) return "batch-variant";
  const out: string[] = m?.architecture?.output_modalities ?? ["text"];
  const inp: string[] = m?.architecture?.input_modalities ?? ["text"];
  if (!out.includes("text") || !inp.includes("text")) return "not-text-chat";
  return null;
}

const RETIRE_AFTER_MS = 7 * 24 * 3600 * 1000;

export function familyOf(modelName: string): string {
  const prefix = modelName.split("/")[0].toLowerCase();
  const map: Record<string, string> = { "meta-llama": "meta", "x-ai": "xai", "mistralai": "mistral", "qwen": "qwen" };
  return map[prefix] ?? prefix;
}

export function categorize(modelName: string): "general_reasoning" | "coding" {
  return /cod(e|er|ex|ing)|devstral/i.test(modelName) ? "coding" : "general_reasoning";
}

/** Maps one OpenRouter model record; returns null for routers/negative-priced pseudo models. */
export function fromOpenRouter(m: any): DiscoveredModel | null {
  if (!m?.id || typeof m.id !== "string") return null;
  if (excludedReason(m)) return null;
  const p = Number(m.pricing?.prompt);
  const c = Number(m.pricing?.completion);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return null;
  const free = p === 0 && c === 0;
  return {
    id: `openrouter:${m.id}`,
    provider: "openrouter",
    modelName: m.id,
    family: familyOf(m.id),
    category: categorize(m.id),
    tier: free ? "FREE_TIER" : "PAID",
    inputCostPer1M: +(p * 1e6).toFixed(6),
    outputCostPer1M: +(c * 1e6).toFixed(6),
    contextWindow: Number.isFinite(Number(m.context_length)) ? Number(m.context_length) : null,
    createdAt: Number.isFinite(Number(m.created)) ? Number(m.created) * 1000 : null,
  };
}

export async function fetchOpenRouter(fetcher: Fetcher): Promise<DiscoveredModel[]> {
  const res = await fetcher("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`openrouter models HTTP ${res.status}`);
  const data = (await res.json()) as any;
  return (data?.data ?? []).map(fromOpenRouter).filter((m: DiscoveredModel | null): m is DiscoveredModel => m !== null);
}

export async function fetchOrcaRouter(fetcher: Fetcher, key: string, baseUrl = "https://api.orcarouter.ai/v1"): Promise<DiscoveredModel[]> {
  const res = await fetcher(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`orcarouter models HTTP ${res.status}`);
  const data = (await res.json()) as any;
  return (data?.data ?? [])
    .filter((m: any) => typeof m?.id === "string")
    .map((m: any) => ({
      id: `orcarouter:${m.id}`,
      provider: "orcarouter",
      modelName: m.id,
      family: familyOf(m.id),
      category: categorize(m.id),
      tier: "PAID" as const, // prices are not published by this endpoint: unknown, never assumed free
      inputCostPer1M: null,
      outputCostPer1M: null,
      contextWindow: null,
      createdAt: Number.isFinite(Number(m.created)) ? Number(m.created) * 1000 : null,
    }));
}

export interface DiscoveryReport {
  source: string;
  seen: number;
  newIds: string[];
  retired: number;
  error?: string;
}

/** Upserts one source's models. Prices/context refresh on every run; first_seen_at is set once. */
export async function upsertDiscovered(db: D1Database, source: string, models: DiscoveredModel[], now: number): Promise<DiscoveryReport> {
  const existing = await db.prepare("SELECT id FROM model_catalog WHERE provider = ?").bind(source).all<{ id: string }>();
  const known = new Set((existing.results ?? []).map((r) => r.id));
  const stmt = db.prepare(`
    INSERT INTO model_catalog (id, provider, model_name, family, category, tier, input_cost_per_1m, output_cost_per_1m,
      context_window, status, lifecycle, source, first_seen_at, last_seen_at, model_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'candidate', 'discovered', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tier = excluded.tier, family = excluded.family, input_cost_per_1m = excluded.input_cost_per_1m, output_cost_per_1m = excluded.output_cost_per_1m,
      source = 'discovered',
      context_window = excluded.context_window, last_seen_at = excluded.last_seen_at, model_created_at = excluded.model_created_at,
      lifecycle = CASE WHEN model_catalog.lifecycle = 'retired' THEN 'candidate' ELSE model_catalog.lifecycle END`);
  const batch = models.map((m) =>
    stmt.bind(m.id, m.provider, m.modelName, m.family, m.category, m.tier, m.inputCostPer1M, m.outputCostPer1M,
      m.contextWindow, now, now, m.createdAt),
  );
  for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
  const retired = await db
    .prepare("UPDATE model_catalog SET lifecycle = 'retired' WHERE provider = ? AND source = 'discovered' AND lifecycle != 'retired' AND last_seen_at < ?")
    .bind(source, now - RETIRE_AFTER_MS)
    .run();
  return { source, seen: models.length, newIds: models.map((m) => m.id).filter((id) => !known.has(id)), retired: retired.meta?.changes ?? 0 };
}

/** Seed rows from the 2024 hand-typed catalog are superseded once a live source lists the same model. */
export async function retireSupersededSeeds(db: D1Database): Promise<number> {
  const r = await db
    .prepare(`UPDATE model_catalog SET lifecycle = 'retired'
      WHERE source = 'seed-2024' AND lifecycle != 'retired'
        AND (provider = 'openrouter' OR model_name IN (SELECT model_name FROM model_catalog WHERE source = 'discovered'))`)
    .run();
  return r.meta?.changes ?? 0;
}

export async function runDiscovery(
  db: D1Database,
  env: { ORCAROUTER_API_KEY?: string; ORCAROUTER_BASE_URL?: string },
  fetcher: Fetcher = (i, init) => fetch(i, init),
  now = Date.now(),
): Promise<DiscoveryReport[]> {
  const reports: DiscoveryReport[] = [];
  try {
    reports.push(await upsertDiscovered(db, "openrouter", await fetchOpenRouter(fetcher), now));
  } catch (e: any) {
    reports.push({ source: "openrouter", seen: 0, newIds: [], retired: 0, error: String(e?.message ?? e) });
  }
  if (env.ORCAROUTER_API_KEY) {
    try {
      reports.push(await upsertDiscovered(db, "orcarouter", await fetchOrcaRouter(fetcher, env.ORCAROUTER_API_KEY, env.ORCAROUTER_BASE_URL), now));
    } catch (e: any) {
      reports.push({ source: "orcarouter", seen: 0, newIds: [], retired: 0, error: String(e?.message ?? e) });
    }
  }
  if (reports.some((r) => r.seen > 0)) await retireSupersededSeeds(db);
  return reports;
}
