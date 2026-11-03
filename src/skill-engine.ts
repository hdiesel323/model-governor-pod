/**
 * ============================================================================
 * CHASSIS - DYNAMIC SKILL ENGINE (HOT-PLUGGABLE SKILLS)
 * ============================================================================
 * Allows worker pods to pull declarative skills on-the-fly from the central
 * Skill Vault without requiring code redeployments.
 */

export interface DynamicSkillPackage {
  id: string;
  name: string;
  domain: string;
  version: string;
  description: string;
  specSchema: Record<string, any>;
  executionType: "prompt_template" | "rule_engine" | "composite";
  instructions: string;
}

let hubAuthToken = "";
/** Set by the worker entry point from FACTORY_HUB_TOKEN; the engine is constructed at module load. */
export function setHubAuthToken(token: string | undefined): void {
  hubAuthToken = token || "";
}

export class DynamicSkillEngine {
  private cache = new Map<string, DynamicSkillPackage>();

  constructor(private hubUrl: string = "https://factory-hub.walterhudson462.workers.dev", private fetcher?: typeof fetch) {}

  public async getSkill(skillId: string): Promise<DynamicSkillPackage | null> {
    if (this.cache.has(skillId)) {
      return this.cache.get(skillId)!;
    }

    try {
      const fn = this.fetcher || fetch;
      const res = await fn(`${this.hubUrl}/api/skills/${encodeURIComponent(skillId)}`, hubAuthToken ? { headers: { Authorization: `Bearer ${hubAuthToken}` } } : undefined);
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      if (data && data.skill) {
        this.cache.set(skillId, data.skill);
        return data.skill;
      }
    } catch (err) {
      console.warn(`[skill-engine] Could not fetch skill '${skillId}' from hub:`, err);
    }
    return null;
  }

  public registerLocalSkill(skill: DynamicSkillPackage): void {
    this.cache.set(skill.id, skill);
  }

  public execute(skill: DynamicSkillPackage, spec: Record<string, any>): Record<string, any> {
    const now = Date.now();

    if (skill.executionType === "rule_engine") {
      return this.executeRuleEngine(skill, spec, now);
    }

    // Default: Declarative Prompt Template execution
    return {
      skillId: skill.id,
      skillName: skill.name,
      version: skill.version,
      executionType: skill.executionType,
      instructions: skill.instructions,
      inputSpec: spec,
      analysis: `Evaluated ${skill.name} successfully against inputs.`,
      executedAt: new Date(now).toISOString(),
    };
  }

  private executeRuleEngine(
    skill: DynamicSkillPackage,
    spec: Record<string, any>,
    timestamp: number
  ): Record<string, any> {
    // 1. Robots.txt Governance
    if (skill.id === "seo.robots_txt_probe") {
      const content = String(spec.robotsTxtContent || "");
      const bots = ["GPTBot", "PerplexityBot", "ClaudeBot", "CCBot"];
      const botStatus: Record<string, "allowed" | "blocked" | "not_specified"> = {};

      for (const bot of bots) {
        const regex = new RegExp(`User-agent:\\s*${bot}[\\s\\S]*?Disallow:\\s*([^\\n\\r]*)`, "i");
        const match = content.match(regex);
        if (match) {
          botStatus[bot] = match[1].trim() === "/" ? "blocked" : "allowed";
        } else {
          // Check wildcard Disallow: /
          const wildcardMatch = content.match(/User-agent:\s*\*[\s\S]*?Disallow:\s*([^\n\r]*)/i);
          if (wildcardMatch && wildcardMatch[1].trim() === "/") {
            botStatus[bot] = "blocked";
          } else {
            botStatus[bot] = "not_specified";
          }
        }
      }

      const blockedCount = Object.values(botStatus).filter((s) => s === "blocked").length;
      const score = Math.max(0, 100 - blockedCount * 25);

      return {
        skillId: skill.id,
        rule: "ai_crawler_governance",
        score,
        botStatus,
        aiSearchFriendly: score >= 75,
        executedAt: new Date(timestamp).toISOString(),
      };
    }

    // 2. Security.txt Compliance
    if (skill.id === "security.security_txt_probe") {
      const content = String(spec.securityTxtContent || "");
      const hasContact = /Contact:\s*\S+/i.test(content);
      const hasExpires = /Expires:\s*\S+/i.test(content);
      const isCompliant = hasContact && hasExpires;

      return {
        skillId: skill.id,
        rule: "rfc_9116_security_txt",
        isCompliant,
        hasContact,
        hasExpires,
        score: isCompliant ? 100 : hasContact ? 50 : 0,
        executedAt: new Date(timestamp).toISOString(),
      };
    }

    // Generic rule fallback
    return {
      skillId: skill.id,
      executed: true,
      spec,
      timestamp,
    };
  }
}
