import "dotenv/config";
import { spawnSync } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig, type ServerMode } from "../src/config.js";
import { createPaths, ensurePaths } from "../src/paths.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const mode: ServerMode = process.argv.includes("--stdio") ? "stdio" : "http";
  const checks: Check[] = [];

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    name: "node",
    ok: nodeMajor >= 22,
    detail: process.versions.node,
  });

  let config;
  try {
    config = loadConfig(mode);
    checks.push({ name: "config", ok: true, detail: `loaded for ${mode}` });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    print(checks);
    process.exitCode = 1;
    return;
  }

  const paths = createPaths(config);
  try {
    await ensurePaths(paths);
    await access(paths.dataDir, constants.W_OK);
    checks.push({ name: "data-dir", ok: true, detail: paths.dataDir });
  } catch (error) {
    checks.push({
      name: "data-dir",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const executable = chromium.executablePath();
  try {
    await access(executable, constants.X_OK);
    checks.push({ name: "chromium", ok: true, detail: executable });
  } catch {
    checks.push({
      name: "chromium",
      ok: false,
      detail: "Chromium missing. Run npm run playwright:install",
    });
  }

  const cloudflared = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  checks.push({
    name: "cloudflared",
    ok: cloudflared.status === 0,
    detail:
      cloudflared.status === 0
        ? cloudflared.stdout.trim() || cloudflared.stderr.trim()
        : "Not installed. Install with: brew install cloudflared",
  });

  if (mode === "http" && config.oauth) {
    checks.push({
      name: "public-url",
      ok: !config.oauth.publicUrl.hostname.includes("YOUR-DOMAIN"),
      detail: config.oauth.publicUrl.href,
    });
    checks.push({
      name: "oauth",
      ok: Boolean(config.oauth.ownerPassword && config.oauth.jwtSecret),
      detail: `resource ${config.oauth.resourceUrl}`,
    });
  }

  print(checks);
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

function print(checks: Check[]): void {
  for (const check of checks) {
    process.stderr.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
