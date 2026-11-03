import { test } from "node:test";
import assert from "node:assert/strict";
import { TincanClient, withHubAuth } from "../src/tincan.js";
import { loadPodConfig } from "../src/config.js";

test("pod sends FACTORY_HUB_TOKEN as Bearer on every hub call via service binding", async () => {
  const seen: (string | null)[] = [];
  const binding = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization"));
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    },
  };
  const config = loadPodConfig({ FACTORY_HUB_TOKEN: "tok-123", FACTORY_HUB_URL: "https://hub.test" });
  assert.equal(config.hubToken, "tok-123");
  const client = new TincanClient(config, binding);
  await client.sendHeartbeat();
  await client.pollInbox(5);
  await client.acknowledge("m1");
  await client.publish("t", "pod:x", {});
  assert.equal(seen.length, 4);
  for (const h of seen) assert.equal(h, "Bearer tok-123");
});

test("withHubAuth preserves existing headers and is a no-op without a token", () => {
  const init = withHubAuth({ method: "POST", headers: { "Content-Type": "application/json" } }, "t");
  const h = new Headers(init?.headers);
  assert.equal(h.get("Content-Type"), "application/json");
  assert.equal(h.get("Authorization"), "Bearer t");
  const plain = { method: "GET" };
  assert.equal(withHubAuth(plain, ""), plain);
});
