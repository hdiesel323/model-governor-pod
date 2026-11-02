#!/usr/bin/env node

/**
 * ============================================================================
 * AUTONOMOUS POD SCAFFOLDER
 * ============================================================================
 * Stamps out an isolated, edge-first Autonomous Worker Pod for any project
 * or domain.
 *
 * Usage:
 *   node bin/scaffold.js --name <pod-name> --role <role> --domain <domain> [--out <dir>]
 *
 * Example:
 *   node bin/scaffold.js --name analytics-processor --role processor --domain telemetry
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    name: "",
    role: "worker",
    domain: "default",
    out: "",
    createDb: true,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) params.name = args[++i];
    if (args[i] === "--role" && args[i + 1]) params.role = args[++i];
    if ((args[i] === "--domain" || args[i] === "--lob") && args[i + 1]) params.domain = args[++i];
    if (args[i] === "--out" && args[i + 1]) params.out = args[++i];
    if (args[i] === "--no-db") params.createDb = false;
  }

  if (!params.name) {
    console.error("❌ Error: Missing --name argument.");
    console.log("Usage: node bin/scaffold.js --name <pod-name> --role <role> --domain <domain> [--out <dir>]");
    process.exit(1);
  }

  if (!params.out) {
    params.out = resolve(process.cwd(), "..", params.name);
  } else {
    params.out = resolve(params.out);
  }

  return params;
}

function main() {
  const { name, role, domain, out, createDb } = parseArgs();
  const templateDir = resolve(import.meta.dirname, "..");

  console.log(`\n======================================================`);
  console.log(`⚡ AUTONOMOUS POD SCAFFOLDER`);
  console.log(`======================================================`);
  console.log(`📦 Pod Name:         ${name}`);
  console.log(`🎭 Role:             ${role}`);
  console.log(`🌐 Project / Domain: ${domain}`);
  console.log(`📁 Destination:      ${out}`);
  console.log(`======================================================\n`);

  if (existsSync(out)) {
    console.error(`❌ Target directory already exists: ${out}`);
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });

  // 1. Copy chassis template files (exclude git, node_modules, builds)
  console.log("Copying chassis template files...");
  cpSync(templateDir, out, {
    recursive: true,
    filter: (src) => {
      return (
        !src.includes("node_modules") &&
        !src.includes(".git") &&
        !src.includes("dist") &&
        !src.includes(".wrangler") &&
        !src.endsWith(".sqlite")
      );
    },
  });

  // 2. Customize package.json
  const pkgPath = join(out, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.name = name;
    pkg.description = `Autonomous ${role.toUpperCase()} Worker Pod for Domain: ${domain}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  // 3. Customize config defaults in src/config.ts
  const configPath = join(out, "src", "config.ts");
  if (existsSync(configPath)) {
    let content = readFileSync(configPath, "utf8");
    const formattedName = name
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    content = content.replace(`get("POD_ID", "worker-pod-01")`, `get("POD_ID", "${name}")`);
    content = content.replace(`get("POD_NAME", "Worker Pod")`, `get("POD_NAME", "${formattedName}")`);
    content = content.replace(`get("POD_ROLE", "worker")`, `get("POD_ROLE", "${role}")`);
    content = content.replace(`get("POD_DOMAIN", get("POD_LOB", "default"))`, `get("POD_DOMAIN", get("POD_LOB", "${domain}"))`);
    writeFileSync(configPath, content);
  }

  // 4. Customize wrangler.jsonc
  const wranglerPath = join(out, "wrangler.jsonc");
  if (existsSync(wranglerPath)) {
    let content = readFileSync(wranglerPath, "utf8");
    content = content.replace(/"name":\s*"worker-pod-template"/g, `"name": "${name}"`);
    content = content.replace(/"database_name":\s*"worker-pod-db"/g, `"database_name": "${name}-db"`);
    writeFileSync(wranglerPath, content);
  }

  // 5. Create Cloudflare D1 Database if requested
  if (createDb) {
    console.log(`\nCreating Cloudflare D1 database: ${name}-db...`);
    try {
      const outText = execSync(`npx wrangler d1 create ${name}-db`, {
        encoding: "utf8",
        timeout: 15000,
        shell: "/bin/sh",
      });

      const uuidMatch =
        outText.match(/"database_id":\s*"([a-f0-9-]+)"/) ||
        outText.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);

      if (uuidMatch && uuidMatch[1]) {
        const dbId = uuidMatch[1];
        console.log(`✅ Created D1 database ID: ${dbId}`);
        let wranglerContent = readFileSync(wranglerPath, "utf8");
        wranglerContent = wranglerContent.replace(
          /"database_id":\s*"[^"]*"/,
          `"database_id": "${dbId}"`
        );
        writeFileSync(wranglerPath, wranglerContent);
      }
    } catch {
      console.warn("⚠️ Could not auto-create D1 database (create manually via: wrangler d1 create " + name + "-db).");
    }
  }

  console.log(`\n🎉 Successfully scaffolded ${name}!`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${out}`);
  console.log(`  npm install`);
  console.log(`  # Implement domain task handling in src/handler.ts`);
  console.log(`  just cf-schema ${name}-db   # apply D1 tables`);
  console.log(`  just cf-deploy             # deploy to Cloudflare Workers\n`);
}

main();
