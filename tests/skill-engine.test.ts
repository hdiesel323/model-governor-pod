import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DynamicSkillEngine, DynamicSkillPackage } from "../src/skill-engine.js";

describe("Dynamic Skill Engine & Hot-Plugging Test Suite", () => {
  test("1. Executes rule_engine skill dynamically without compiled code", () => {
    const engine = new DynamicSkillEngine("http://localhost:5000");

    const robotsSkill: DynamicSkillPackage = {
      id: "seo.robots_txt_probe",
      name: "AI Crawler Governance",
      domain: "seo",
      version: "1.0.0",
      description: "Test rule",
      executionType: "rule_engine",
      specSchema: {},
      instructions: "Evaluate bot directives",
    };

    engine.registerLocalSkill(robotsSkill);

    const result = engine.execute(robotsSkill, {
      robotsTxtContent: `
User-agent: GPTBot
Disallow: /

User-agent: PerplexityBot
Disallow:

User-agent: *
Disallow:
      `,
    });

    assert.equal(result.skillId, "seo.robots_txt_probe");
    assert.equal(result.botStatus.GPTBot, "blocked");
    assert.equal(result.botStatus.PerplexityBot, "allowed");
    assert.equal(result.score, 75);
    assert.equal(result.aiSearchFriendly, true);
  });

  test("2. Executes security_txt rule engine and detects non-compliance", () => {
    const engine = new DynamicSkillEngine("http://localhost:5000");

    const secSkill: DynamicSkillPackage = {
      id: "security.security_txt_probe",
      name: "RFC 9116 Security.txt",
      domain: "security",
      version: "1.0.0",
      description: "Test security",
      executionType: "rule_engine",
      specSchema: {},
      instructions: "Check contact and expires",
    };

    // Test missing Contact:
    const invalidRes = engine.execute(secSkill, {
      securityTxtContent: "Expires: 2026-12-31T23:59:59Z",
    });
    assert.equal(invalidRes.isCompliant, false);
    assert.equal(invalidRes.score, 0);

    // Test valid Contact + Expires:
    const validRes = engine.execute(secSkill, {
      securityTxtContent: "Contact: security@example.com\nExpires: 2026-12-31T23:59:59Z",
    });
    assert.equal(validRes.isCompliant, true);
    assert.equal(validRes.score, 100);
  });
});
