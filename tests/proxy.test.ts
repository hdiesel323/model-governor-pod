// OpenAI-compatible proxy: real SQLite behind the D1 shape, fetch stubbed, so nothing calls a provider.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chatCompletions, listModels, proxyRoute } from "../src/proxy.js";

function d1(sqlite: DatabaseSync): any {
  const prep = (q: string) => {
    const stmt = sqlite.prepare(q);
    const bound = (...p: any[]) => ({
      run: async () => ({ meta: { changes: Number(stmt.run(...p).changes) } }),
      all: async () => ({ results: stmt.all(...p) }),
      first: async () => stmt.get(...p) ?? null,
    });
    return { bind: bound, ...bound() };
  };
  return { prepare: prep };
}

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(decodeURIComponent(new URL("../schema.sql", import.meta.url).pathname), "utf8"));
  const add = (id: string, provider: string, name: string, score: number, tier = "FREE_TIER", lifecycle = "qualified") =>
    sqlite.prepare(`INSERT INTO model_catalog (id, provider, model_name, category, tier, lifecycle, status, quality_score)
      VALUES (?, ?, ?, 'general_reasoning', ?, ?, 'active', ?)`).run(id, provider, name, tier, lifecycle, score);
  add("codex:gpt-x", "codex", "gpt-x", 99, "OAUTH");
  add("openrouter:acme/best:free", "openrouter", "acme/best:free", 90);
  add("orcarouter:acme/second", "orcarouter", "acme/second", 80);
  add("openrouter:acme/candidate", "openrouter", "acme/candidate", 95, "FREE_TIER", "candidate");
  return d1(sqlite);
}

const env = (DB: any) => ({ DB, OPENROUTER_API_KEY: "or-key", ORCAROUTER_API_KEY: "orca-key" });

const chat = (body: any) =>
  new Request("https://g/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });

const ok = (model: string) =>
  new Response(JSON.stringify({ model, choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("proxy", () => {
  test("serves /v1 and the /api/inference base OpenBot was configured with", () => {
    assert.equal(proxyRoute("/v1/chat/completions"), "chat");
    assert.equal(proxyRoute("/api/inference/chat/completions"), "chat");
    assert.equal(proxyRoute("/api/inference/v1/chat/completions"), "chat");
    assert.equal(proxyRoute("/api/inference/models"), "models");
    assert.equal(proxyRoute("/api/models"), null, "the catalog route is not the proxy");
  });

  test("auto routes to the best qualified model the Worker can reach, never an OAuth one", async () => {
    const calls: any[] = [];
    const res = await chatCompletions(chat({ model: "auto", messages: [] }), env(seeded()), {}, "pod", async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init!.body)), auth: (init!.headers as any).Authorization });
      return ok("x");
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Governor-Model"), "openrouter:acme/best:free");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(calls[0].body.model, "acme/best:free", "upstream gets the provider's model name");
    assert.equal(calls[0].auth, "Bearer or-key");
  });

  test("falls back to the next qualified model on a provider failure", async () => {
    const res = await chatCompletions(chat({ model: "auto", messages: [] }), env(seeded()), {}, "pod", async (url) =>
      url.includes("openrouter") ? new Response("busy", { status: 429 }) : ok("x"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Governor-Model"), "orcarouter:acme/second");
    assert.equal(res.headers.get("X-Governor-Fallbacks"), "1");
  });

  test("a provider without a key is not routed to", async () => {
    const res = await chatCompletions(chat({ model: "auto", messages: [] }), { DB: seeded(), ORCAROUTER_API_KEY: "k" }, {}, "pod", async () => ok("x"));
    assert.equal(res.headers.get("X-Governor-Model"), "orcarouter:acme/second");
  });

  test("explicit ids must be qualified and reachable; nothing reachable is an explicit 503", async () => {
    const DB = seeded();
    const noCall = async () => { throw new Error("must not call upstream"); };
    assert.equal((await chatCompletions(chat({ model: "openrouter:acme/candidate" }), env(DB), {}, "pod", noCall)).status, 503);
    assert.equal((await chatCompletions(chat({ model: "codex:gpt-x" }), env(DB), {}, "pod", noCall)).status, 503);
    assert.equal((await chatCompletions(chat({ model: "auto" }), { DB }, {}, "pod", noCall)).status, 503);
  });

  test("a request error is returned as-is, not retried on another model", async () => {
    let n = 0;
    const res = await chatCompletions(chat({ model: "auto" }), env(seeded()), {}, "pod", async () => {
      n++;
      return new Response('{"error":"bad"}', { status: 400 });
    });
    assert.equal(res.status, 400);
    assert.equal(n, 1);
  });

  test("streams pass straight through", async () => {
    const res = await chatCompletions(chat({ model: "auto", stream: true }), env(seeded()), {}, "pod", async () =>
      new Response("data: {}\n\ndata: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    assert.equal(res.headers.get("Content-Type"), "text/event-stream");
    assert.equal(await res.text(), "data: {}\n\ndata: [DONE]\n\n");
  });

  test("/models lists the auto ids and reachable qualified models only", async () => {
    const res = await listModels(env(seeded()), {});
    const ids = ((await res.json()) as any).data.map((m: any) => m.id);
    assert.deepEqual(ids, ["auto", "auto-coding", "auto-fast", "openrouter:acme/best:free", "orcarouter:acme/second"]);
  });
});
