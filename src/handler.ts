import { TaskRecord, HandlerContext, TaskHandler } from "./types.js";
import { resolveOptimalModel, recordUsage } from "./governor.js";
import { runDiscovery } from "./discovery.js";
import { runProbeCycle } from "./probe.js";

/**
 * ============================================================================
 * MODEL GOVERNOR POD HANDLER (TOKENMAXXING & RADAR BENCHMARK)
 * ============================================================================
 * Discovers current models from live catalogs, probes them for real, promotes
 * measured models, routes only to qualified ones, and records real usage.
 */

export class ModelGovernorPodHandler implements TaskHandler {
  public name = "model-governor-handler";

  public canHandle(topic: string, _spec: any): boolean {
    return (
      topic === "model.route" ||
      topic === "model.track_usage" ||
      topic === "model.radar_scan" ||
      topic.startsWith("telemetry.")
    );
  }

  public async handle(task: TaskRecord, context: HandlerContext): Promise<any> {
    const { podConfig, now, publishEvent } = context;

    console.log(`[${podConfig.id}] 🧠 Processing model governance task: ${task.taskId} (Topic: ${task.topic})`);

    let resultPayload: any = {};
    const db = context.db;
    if (!db) throw new Error("model governor handler needs D1 (context.db); no fabricated fallback");

    // 1. model.radar_scan: real discovery + one real probe cycle (factory-hub#78). No hardcoded numbers.
    if (task.topic === "model.radar_scan") {
      const discovery = await runDiscovery(db, context.env ?? {});
      const probes = await runProbeCycle(db, context.env ?? {});
      resultPayload = { discovery: discovery.map((r) => ({ ...r, newIds: r.newIds.slice(0, 50), newCount: r.newIds.length })), probes };
      await publishEvent("model.radar_report", "pod:pm", { governor: podConfig.id, findings: resultPayload, timestamp: now });
    }

    // 2. model.track_usage: persisted from a real pod receipt.
    else if (task.topic === "model.track_usage") {
      const u = task.spec || {};
      if (!u.podId || !u.modelId) throw new Error("track_usage needs podId and modelId from a real receipt");
      resultPayload = await recordUsage(db, {
        podId: u.podId,
        taskId: u.taskId,
        provider: u.provider || "unknown",
        modelId: u.modelId,
        promptTokens: Number(u.promptTokens || 0),
        completionTokens: Number(u.completionTokens || 0),
        latencyMs: Number(u.latencyMs || 0),
        tier: u.tier,
        actualCost: u.actualCost,
      });
    }

    // 3. model.route: only qualified (measured) models; explicit null when none.
    else {
      const spec = task.spec || {};
      const model = await resolveOptimalModel(db, spec.category || "general_reasoning", {
        excludeFamily: spec.excludeFamily,
        maxOutputCostPer1M: spec.maxOutputCostPer1M,
      });
      resultPayload = model
        ? { recommendedModel: model }
        : { recommendedModel: null, reason: `no qualified model for category ${spec.category || "general_reasoning"}` };
    }

    const executionResult = {
      completedBy: podConfig.id,
      role: podConfig.role,
      domain: podConfig.lob,
      taskId: task.taskId,
      topic: task.topic,
      data: resultPayload,
      completedAt: new Date(now).toISOString(),
    };

    // Report task completion back to the orchestration hub
    await publishEvent("task.completed", "hub", {
      taskId: task.taskId,
      workerPod: podConfig.id,
      event: "completed",
      result: executionResult,
      timestamp: now,
    });

    return executionResult;
  }
}

export const activeHandler: TaskHandler = new ModelGovernorPodHandler();
export { ModelGovernorPodHandler as DefaultPodHandler };
