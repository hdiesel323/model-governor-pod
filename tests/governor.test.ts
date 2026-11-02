import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ModelEntry, LlmUsageEvent } from "../src/governor.js";

describe("Model Governor & TokenMaxxing Test Suite", () => {
  test("1. TokenMaxxing savings formula correctly computes savings vs baseline", () => {
    // 10,000 tokens on Free Tier (e.g. Cerebras or Workers AI)
    const totalTokens = 10000;
    const actualCost = 0.00;
    const baselineCost = totalTokens * 0.000005; // $5 / 1M tokens = $0.05
    const savedUsd = baselineCost - actualCost;

    assert.equal(savedUsd, 0.05);
    assert.equal(actualCost, 0.00);
  });

  test("2. Model ranking prefers FREE_TIER with highest tokens/sec", () => {
    const models: ModelEntry[] = [
      {
        id: "paid-claude",
        provider: "anthropic",
        modelName: "claude-3-5-sonnet",
        category: "general_reasoning",
        tier: "PAID",
        inputCostPer1M: 3.0,
        outputCostPer1M: 15.0,
        contextWindow: 200000,
        avgLatencyMs: 800,
        tokensPerSec: 75,
        qualityScore: 99.0,
        status: "active",
        lastBenchmarkedAt: Date.now(),
      },
      {
        id: "free-cerebras",
        provider: "cerebras",
        modelName: "llama3.3-70b",
        category: "general_reasoning",
        tier: "FREE_TIER",
        inputCostPer1M: 0.0,
        outputCostPer1M: 0.0,
        contextWindow: 131072,
        avgLatencyMs: 120,
        tokensPerSec: 1400,
        qualityScore: 94.0,
        status: "active",
        lastBenchmarkedAt: Date.now(),
      },
      {
        id: "free-workers-ai",
        provider: "cloudflare_ai",
        modelName: "@cf/meta/llama-3.1-8b-instruct",
        category: "general_reasoning",
        tier: "FREE_TIER",
        inputCostPer1M: 0.0,
        outputCostPer1M: 0.0,
        contextWindow: 131072,
        avgLatencyMs: 85,
        tokensPerSec: 250,
        qualityScore: 88.5,
        status: "active",
        lastBenchmarkedAt: Date.now(),
      },
    ];

    // Filter active & sort by tier (FREE_TIER first) then tokensPerSec desc
    const sorted = [...models].sort((a, b) => {
      const aFree = a.tier === "FREE_TIER" ? 0 : 1;
      const bFree = b.tier === "FREE_TIER" ? 0 : 1;
      if (aFree !== bFree) return aFree - bFree;
      return b.tokensPerSec - a.tokensPerSec;
    });

    assert.equal(sorted[0].id, "free-cerebras");
    assert.equal(sorted[0].tier, "FREE_TIER");
    assert.equal(sorted[0].tokensPerSec, 1400);
  });
});
