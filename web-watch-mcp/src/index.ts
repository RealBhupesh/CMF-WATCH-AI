import "dotenv/config";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, type ServerMode } from "./config.js";
import { Logger } from "./logger.js";
import { createMcpServer } from "./mcp-server.js";
import { createRuntime } from "./runtime.js";
import { startHttpServer } from "./http/server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

function parseMode(argv: string[]): ServerMode {
  if (argv.includes("--stdio")) {
    return "stdio";
  }
  if (argv.includes("--http")) {
    return "http";
  }

  if (process.stdin.isTTY) {
    return "http";
  }

  return "stdio";
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const config = loadConfig(mode);
  const logger = new Logger(config.logLevel, "job-crawler");
  const runtime = await createRuntime(config, logger);

  if (mode === "stdio") {
    logger.info("Starting MCP server over stdio", {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });

    const handle = serveStdio(() => createMcpServer(runtime), {
      onerror: (error) => {
        logger.error("stdio MCP error", { error: error.message });
      },
    });

    const shutdown = async (signal: string): Promise<void> => {
      logger.info("Shutting down", { signal });
      await handle.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      process.exit(0);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    runtime.automation.start();
    runtime.watchRunner.start();
    return;
  }

  const httpServer = await startHttpServer(runtime, logger);
  runtime.automation.start();
  runtime.watchRunner.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Shutting down", { signal });
    await httpServer.close().catch((error) => {
      logger.warn("Shutdown error", { error: String(error) });
    });
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      scope: "job-crawler",
      message: "Fatal startup error",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
