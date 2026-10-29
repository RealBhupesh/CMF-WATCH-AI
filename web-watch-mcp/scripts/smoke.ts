import "dotenv/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createRuntime } from "../src/runtime.js";

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "browser-smoke-"));
  const config = loadConfig("stdio", {
    ...process.env,
    DATA_DIR: directory,
    BROWSER_PROFILE_DIR: join(directory, "browser-profile"),
    BROWSER_HEADLESS: "true",
  });
  const logger = new Logger(config.logLevel, "smoke");
  const runtime = await createRuntime(config, logger);

  try {
    const server = createMcpServer(runtime);
    process.stderr.write(`MCP server created: ${server.constructor.name}\n`);

    const profile = await runtime.profile.get();
    process.stderr.write(`Profile empty: ${profile.isEmpty}\n`);

    const resumes = await runtime.resumes.list();
    process.stderr.write(`Saved resumes: ${resumes.length}\n`);

    const stats = await runtime.applications.stats();
    process.stderr.write(`Applications logged: ${stats.total}\n`);

    await runtime.browser.ensureStarted();
    const status = await runtime.browser.status();
    process.stderr.write(
      `Browser: running=${status.running} headless=${status.headless} pages=${status.pageCount}\n`,
    );

    const target = process.env.SMOKE_URL ?? "https://example.com";
    const navigation = await runtime.browser.navigate(target);
    process.stderr.write(
      `Navigated: ${navigation.url} status=${navigation.status} refs=${navigation.snapshot.elements.length}\n`,
    );

    const extracted = await runtime.browser.extract({ includeLinks: false });
    process.stderr.write(`Extracted title: ${extracted.title}\n`);
    process.stderr.write(`Extracted text chars: ${extracted.text.length}\n`);
    process.stderr.write(`Verification detected: ${extracted.verification.detected}\n`);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
