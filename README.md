# Model Governor Pod

> Autonomous TokenMaxxing Engine, Cost Telemetry & Proactive Model Radar on Cloudflare Workers + D1.

The **Model Governor Pod** (`model-governor-pod`) acts as the central intelligence and cost-optimization gateway for the autonomous agent collective. It enforces a strict **TokenMaxxing strategy**—routing standard tasks to 100% free/OAuth models, logging real-time token spend and savings, and proactively benchmarking new models in the wild.

- **Live URL**: [https://model-governor-pod.walterhudson462.workers.dev](https://model-governor-pod.walterhudson462.workers.dev)
- **Domain**: `telemetry`
- **Role**: `governor`
- **Cloudflare D1 Database**: `model-governor-pod-db` (`2c475965-3e8a-4d0c-b0dc-389283ca8634`)
- **Native Edge AI**: Direct Cloudflare **Workers AI** binding (`env.AI`)

---

## 🏗️ Architecture

```
 ┌────────────────────────────────────────────────────────┐
 │                      Factory Hub                       │
 │        https://factory-hub.walterhudson462.workers.dev │
 └─────────────┬────────────────────────────▲─────────────┘
               │ model.radar_report         │ heartbeat
               │ (Telemetry Envelope)       │ model.route
               ▼                            │
 ┌──────────────────────────────────────────┴─────────────┐
 │         Model Governor Pod (Cloudflare Worker)         │
 │                                                        │
 │  ┌──────────────┐   ┌───────────────┐  ┌─────────────┐ │
 │  │ / (Cockpit)  │   │  Tincan Mesh  │  │  Cron / 5m  │ │
 │  │ TokenMaxxing │   │  Client Node  │  │ Model Radar │ │
 │  └──────────────┘   └───────┬───────┘  └──────┬──────┘ │
 │                             │                 │        │
 │                     ┌───────▼─────────────────▼──────┐ │
 │                     │    TokenMaxxing Routing &      │ │
 │                     │       Telemetry Engine         │ │
 │                     └───────┬────────────────────────┘ │
 │                             │                          │
 │              ┌──────────────┴──────────────┐           │
 │              ▼                             ▼           │
 │      ┌───────────────┐             ┌───────────────┐   │
 │      │ Cloudflare D1 │             │ Workers AI    │   │
 │      │ Usage Ledger  │             │ Free Models   │   │
 │      └───────────────┘             └───────────────┘   │
 └────────────────────────────────────────────────────────┘
```

---

## ⚡ The TokenMaxxing Hierarchy

To keep API spend near **$0.00** across dozens of active pods, the Governor routes traffic through a prioritized tier cascade:

| Tier | Provider & Model | Category | Cost / 1M Tokens | Throughput | Use Case |
|---|---|---|---|---|---|
| **Tier 0 (Free)** | **Cloudflare Workers AI**<br>`@cf/meta/llama-3.1-8b-instruct` | `fast_classification` | **$0.00** | ~240 tok/s (85ms) | Intent classification, topic routing, quick extraction. |
| **Tier 0 (Free)** | **Cerebras**<br>`llama3.3-70b` | `general_reasoning` | **$0.00** | **~1,400 tok/s** (120ms) | Standard task execution, JSON structuring, audits. |
| **Tier 0 (Free)** | **OpenRouter Free**<br>`google/gemini-2.0-flash-exp:free` | `general_reasoning` | **$0.00** | ~185 tok/s (200ms) | Large document parsing (up to 1,000,000 token context). |
| **Tier 0 (Free)** | **OpenRouter Free**<br>`deepseek/deepseek-r1:free` | `deep_audit` | **$0.00** | ~95 tok/s (450ms) | Complex logic verification and mathematical reasoning. |
| **Tier 1 (Cheap)** | **Fireworks AI**<br>`llama-3.3-70b-instruct` | `general_reasoning` | $0.90 | ~160 tok/s (180ms) | Fallback when free provider quotas are momentarily rate-limited. |
| **Tier 2 (Gated)** | **Anthropic**<br>`claude-3-5-sonnet-20241022` | `deep_audit` | $3.00 in / $15.00 out | ~75 tok/s (850ms) | **Strictly gated** for high-risk Red Team verification gates. |

---

## 📡 API Reference

### 1. Dynamic Model Route (`GET /api/models/route`)
Worker pods query this endpoint to receive the optimal model for their category:
```bash
curl -s "https://model-governor-pod.walterhudson462.workers.dev/api/models/route?category=general_reasoning&prefer_free=true"
```
**Response**:
```json
{
  "recommendedModel": {
    "id": "cerebras-llama-3-3-70b",
    "provider": "cerebras",
    "modelName": "llama3.3-70b",
    "category": "general_reasoning",
    "tier": "FREE_TIER",
    "inputCostPer1M": 0,
    "outputCostPer1M": 0,
    "tokensPerSec": 1400,
    "qualityScore": 94
  }
}
```

### 2. Record Usage Telemetry (`POST /api/telemetry/log`)
Logs token usage, computes actual cost, and calculates dollars saved vs flagship GPT-4o baseline:
```bash
curl -X POST https://model-governor-pod.walterhudson462.workers.dev/api/telemetry/log \
  -H "Content-Type: application/json" \
  -d '{
    "podId": "authority-seo-pod",
    "taskId": "task_101",
    "provider": "cerebras",
    "modelId": "cerebras-llama-3-3-70b",
    "promptTokens": 1200,
    "completionTokens": 350,
    "latencyMs": 115,
    "tier": "FREE_TIER",
    "actualCost": 0.00
  }'
```

### 3. Get Telemetry & Savings Stats (`GET /api/telemetry/stats`)
Returns network-wide token consumption and TokenMaxxing efficiency:
```bash
curl -s https://model-governor-pod.walterhudson462.workers.dev/api/telemetry/stats
```
**Response**:
```json
{
  "stats": {
    "totalTokens": 5600,
    "totalCostUsd": 0,
    "totalSavedUsd": 0.028,
    "freeTierPercentage": 100,
    "eventsCount": 3,
    "topProviders": [
      { "provider": "openrouter", "tokens": 3100, "cost": 0 },
      { "provider": "cerebras", "tokens": 1550, "cost": 0 },
      { "provider": "cloudflare_ai", "tokens": 950, "cost": 0 }
    ]
  }
}
```

### 4. List Model Catalog (`GET /api/models`)
Returns all active models with speed, context window, and pricing.

---

## 🔍 Proactive Model Radar

Every 5 minutes (or via topic `model.radar_scan`), the Governor runs health and throughput probes against free model providers:
1. Verifies endpoint availability and HTTP latency.
2. Checks for provider rate-limits or quota deprecation.
3. Dynamically updates `model_catalog` in D1 so all worker pods instantly shift traffic to the fastest healthy free model.

---

## 🧪 Testing & Verification

```bash
# Run unit tests
npm test

# Type check
npm run check

# Run local development server
npm run dev
```

---

## 📜 License
MIT License. Free to use, adapt, and build upon.
