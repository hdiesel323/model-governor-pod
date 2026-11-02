import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPodConfig } from "../src/config.js";
import { DefaultPodHandler } from "../src/handler.js";
import { renderPodUiHtml } from "../src/ui.js";
import { TaskRecord } from "../src/types.js";

describe("Autonomous Worker Pod Chassis Test Suite", () => {
  test("1. loadPodConfig applies defaults and environment overrides", () => {
    const config = loadPodConfig({
      POD_ID: "sample-worker-pod",
      POD_NAME: "Sample Worker Pod",
      POD_ROLE: "worker",
      POD_DOMAIN: "telemetry",
      POD_CAPABILITIES: "data_processing,stream_filtering",
    });

    assert.equal(config.id, "sample-worker-pod");
    assert.equal(config.name, "Sample Worker Pod");
    assert.equal(config.role, "worker");
    assert.equal(config.lob, "telemetry");
    assert.deepEqual(config.capabilities, ["data_processing", "stream_filtering"]);
  });

  test("2. DefaultPodHandler executes task and reports progress", async () => {
    const handler = new DefaultPodHandler();
    const config = loadPodConfig();
    let publishedTopic = "";

    const task: TaskRecord = {
      id: 1,
      taskId: "task_test_101",
      topic: "data.process",
      source: "unit-test",
      spec: { recordId: "rec_101" },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await handler.handle(task, {
      podConfig: config,
      now: Date.now(),
      publishEvent: async (topic, toPod, payload) => {
        publishedTopic = topic;
      },
    });

    assert.equal(res.taskId, "task_test_101");
    assert.equal(res.role, config.role);
    assert.equal(publishedTopic, "task.completed");
  });

  test("3. renderPodUiHtml produces valid cockpit markup", () => {
    const config = loadPodConfig();
    const html = renderPodUiHtml(config, []);

    assert.equal(html.includes("Worker Pod Cockpit"), true);
    assert.equal(html.includes("DOMAIN:"), true);
    assert.equal(html.includes("Task Execution Ledger"), true);
  });
});
