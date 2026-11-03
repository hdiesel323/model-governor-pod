// factory-hub#78: honest governor. Real SQLite (node:sqlite) behind a D1-shaped adapter; fetch is stubbed,
// so nothing here calls a provider or spends money.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { familyOf, fromOpenRouter, runDiscovery } from "../src/discovery.js";
import { clean, estimateSuiteCost, gradeZipRegex, probeModel, recordProbe, runProbeCycle, SUITE } from "../src/probe.js";
import { resolveOptimalModel, getModelCatalog } from "../src/governor.js";
import { authGate } from "../src/auth.js";

function d1(sqlite: DatabaseSync): any {
  const prep = (q: string) => {
    const stmt = sqlite.prepare(q);
    const bound = (...p: any[]) => ({
      run: async () => ({ meta: { changes: Number(stmt.run(...p).changes) } }),
      all: async () => ({ results: stmt.all(...p) }),
      first: async () => stmt.get(...p) ?? null,
      _exec: () => stmt.run(...p),
    });
    return { bind: bound, ...bound() };
  };
  return { prepare: prep, batch: async (stmts: any[]) => stmts.map((s) => s._exec()) };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(decodeURIComponent(new URL("../schema.sql", import.meta.url).pathname), "utf8"));
  return { sqlite, db: d1(sqlite) };
}

const orModels = {
  data: [
    { id: "acme/free-coder:free", context_length: 131072, created: 1793000000, pricing: { prompt: "0", completion: "0" } },
    { id: "anthropic/claude-x", context_length: 200000, created: 1793000000, pricing: { prompt: "0.000003", completion: "0.000015" } },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
    { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["audio"] } },
    { id: "openai/gpt-x:batch", pricing: { prompt: "0.000001", completion: "0.000002" } },
  ],
};
const fetchCatalog = async () => new Response(JSON.stringify(orModels), { status: 200 });

/** A stub provider that answers the smoke suite correctly (or with a fixed wrong answer). */
function answering(correct: boolean) {
  const answers: Record<string, string> = { exact: "PONG", json: '{"a":391,"b":"x"}', instruction: "2,3,5,7,11", code_read: "12", code_write: "/^\\d{5}$/" };
  return async (_url: string, init?: RequestInit) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
    const item = SUITE.find((s) => s.prompt === prompt)!;
    const content = correct ? answers[item.name] : "nope";
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }), { status: 200 });
  };
}

describe("discovery", () => {
  test("maps real OpenRouter records; drops negative-priced routers", () => {
    const m = fromOpenRouter(orModels.data[1])!;
    assert.equal(m.id, "openrouter:anthropic/claude-x");
    assert.equal(m.family, "anthropic");
    assert.equal(m.tier, "PAID");
    assert.equal(m.outputCostPer1M, 15);
    assert.equal(fromOpenRouter(orModels.data[0])!.tier, "FREE_TIER");
    assert.equal(fromOpenRouter(orModels.data[2]), null);
    assert.equal(fromOpenRouter(orModels.data[3]), null, "music model is not a chat model");
    assert.equal(fromOpenRouter(orModels.data[4]), null, "batch variants are skipped");
    assert.equal(familyOf("meta-llama/llama-4"), "meta");
  });

  test("upserts as unmeasured candidates and retires superseded 2024 seeds", async () => {
    const { db, sqlite } = freshDb();
    sqlite.exec(`INSERT INTO model_catalog (id, provider, model_name, category, tier, lifecycle, source) VALUES ('old', 'openrouter', 'google/gemini-2.0-flash-exp:free', 'general_reasoning', 'FREE_TIER', 'candidate', 'seed-2024')`);
    const reports = await runDiscovery(db, {}, fetchCatalog, 1_800_000_000_000);
    assert.equal(reports[0].seen, 2);
    assert.equal(reports[0].newIds.length, 2);
    const rows = sqlite.prepare("SELECT id, lifecycle, quality_score, tokens_per_sec, first_seen_at FROM model_catalog ORDER BY id").all() as any[];
    const fresh = rows.find((r) => r.id === "openrouter:acme/free-coder:free");
    assert.equal(fresh.lifecycle, "candidate");
    assert.equal(fresh.quality_score, null, "no invented measurements");
    assert.equal(fresh.tokens_per_sec, null);
    assert.equal(fresh.first_seen_at, 1_800_000_000_000);
    assert.equal(rows.find((r) => r.id === "old").lifecycle, "retired");
    const again = await runDiscovery(db, {}, fetchCatalog, 1_800_000_100_000);
    assert.equal(again[0].newIds.length, 0, "second run discovers nothing new");
  });
});

describe("probing and promotion", () => {
  test("graders are deterministic", () => {
    assert.equal(gradeZipRegex("/^\\d{5}$/"), true);
    assert.equal(gradeZipRegex("/\\d{5}/"), false, "unanchored matches 123456");
    assert.equal(clean("<think>hm</think>\n```\n12\n```"), "12");
  });

  test("a free model qualifies only after 3 measured passing runs", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const target = { id: "openrouter:acme/free-coder:free", provider: "openrouter", modelName: "acme/free-coder:free", tier: "FREE_TIER", inputCostPer1M: 0, outputCostPer1M: 0 };
    const env = { OPENROUTER_API_KEY: "k" };
    for (let i = 1; i <= 3; i++) {
      const r = await probeModel(target, env, answering(true) as any);
      assert.equal(r.passed, SUITE.length);
      const lifecycle = await recordProbe(db, target, r, Date.now() + i);
      assert.equal(lifecycle, i < 3 ? "candidate" : "qualified");
    }
    const row = sqlite.prepare("SELECT quality_score, probe_runs, last_benchmarked_at FROM model_catalog WHERE id = ?").get(target.id) as any;
    assert.equal(row.quality_score, 100);
    assert.equal(row.probe_runs, 3);
    assert.ok(row.last_benchmarked_at > 1_790_000_000_000, "measured now, not in 2024");
  });

  test("provider errors are recorded but never count as quality runs", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const target = { id: "openrouter:acme/free-coder:free", provider: "openrouter", modelName: "acme/free-coder:free", tier: "FREE_TIER", inputCostPer1M: 0, outputCostPer1M: 0 };
    const r = await probeModel(target, { OPENROUTER_API_KEY: "k" }, (async () => new Response("slow down", { status: 429 })) as any);
    assert.equal(await recordProbe(db, target, r, Date.now()), "provider_error");
    const row = sqlite.prepare("SELECT probe_runs, status FROM model_catalog WHERE id = ?").get(target.id) as any;
    assert.equal(row.probe_runs, 0);
    assert.equal(row.status, "rate_limited");
  });

  test("paid models: never probed with budget 0, never qualified without approval", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const calls: string[] = [];
    const spy = (async (url: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body)).model); return answering(true)(url, init); }) as any;
    const cycle = await runProbeCycle(db, { OPENROUTER_API_KEY: "k" }, spy, Date.now());
    assert.ok(cycle.skippedPaid.includes("openrouter:anthropic/claude-x"));
    assert.ok(!calls.includes("anthropic/claude-x"), "no paid call at budget 0");
    const paid = { id: "openrouter:anthropic/claude-x", provider: "openrouter", modelName: "anthropic/claude-x", tier: "PAID", inputCostPer1M: 3, outputCostPer1M: 15 };
    assert.ok((estimateSuiteCost(paid) ?? 0) > 0);
    for (let i = 0; i < 3; i++) await recordProbe(db, paid, await probeModel(paid, { OPENROUTER_API_KEY: "k" }, answering(true) as any), Date.now() + i);
    assert.equal((sqlite.prepare("SELECT lifecycle FROM model_catalog WHERE id = ?").get(paid.id) as any).lifecycle, "candidate", "unapproved paid stays candidate");
  });
});

describe("credit exhaustion", () => {
  test("a 402 pauses all paid probing for 24 h; free probing continues", async () => {
    const { db } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    const paidCalls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      if (!model.endsWith(":free")) { paidCalls.push(model); return new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 }); }
      return answering(true)(url, init);
    }) as any;
    const first = await runProbeCycle(db, { OPENROUTER_API_KEY: "k", PROBE_BUDGET_USD_DAILY: "10" }, fetcher, Date.now());
    assert.ok(paidCalls.length >= 1, "paid model attempted while budget allows");
    const before = paidCalls.length;
    const second = await runProbeCycle(db, { OPENROUTER_API_KEY: "k", PROBE_BUDGET_USD_DAILY: "10" }, fetcher, Date.now() + 1000);
    assert.equal(paidCalls.length, before, "no paid calls while paused");
    assert.ok(second.paidPausedUntil && second.paidPausedUntil > Date.now());
    assert.ok(second.probed.some((p) => p.id.endsWith(":free")), "free probing continues");
    assert.ok(first.probed.length >= 1);
  });
});

describe("routing", () => {
  test("only qualified models route; family exclusion holds; explicit null when none", async () => {
    const { db, sqlite } = freshDb();
    await runDiscovery(db, {}, fetchCatalog, Date.now());
    assert.equal(await resolveOptimalModel(db, "coding"), null, "nothing measured yet -> null, no fallback");
    sqlite.exec(`UPDATE model_catalog SET lifecycle = 'qualified', quality_score = 90, approved_by = 'hd' WHERE id = 'openrouter:anthropic/claude-x'`);
    sqlite.exec(`UPDATE model_catalog SET lifecycle = 'qualified', quality_score = 80 WHERE id = 'openrouter:acme/free-coder:free'`);
    assert.equal((await resolveOptimalModel(db, "coding"))!.id, "openrouter:anthropic/claude-x");
    assert.equal((await resolveOptimalModel(db, "coding", { excludeFamily: "anthropic" }))!.id, "openrouter:acme/free-coder:free");
    assert.equal(await resolveOptimalModel(db, "coding", { excludeFamily: "anthropic,acme" }), null);
    const catalog = await getModelCatalog(db);
    assert.equal(catalog[0].lifecycle, "qualified");
  });
});

describe("auth gate", () => {
  const env = { FACTORY_HUB_TOKEN: "pod-secret", GOVERNOR_ADMIN_TOKEN: "admin-secret" };
  const req = (method: string, path: string, token?: string) =>
    new Request(`https://gov.test${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  test("health open; everything else needs the pod token", () => {
    assert.equal(authGate(req("GET", "/health"), env), null);
    assert.equal(authGate(req("POST", "/api/telemetry/log"), env)!.status, 401);
    assert.equal(authGate(req("GET", "/api/models"), env)!.status, 401);
    assert.equal(authGate(req("GET", "/api/models", "pod-secret"), env), null);
  });
  test("a pod token cannot approve spend; the admin token can", () => {
    assert.equal(authGate(req("POST", "/api/models/x/approve", "pod-secret"), env)!.status, 403);
    assert.equal(authGate(req("POST", "/api/governor/probe", "pod-secret"), env)!.status, 403);
    assert.equal(authGate(req("POST", "/api/models/x/approve", "admin-secret"), env), null);
    assert.equal(authGate(req("POST", "/api/models/x/approve", "admin-secret"), {})!.status, 403, "fails closed without admin token");
  });
});
