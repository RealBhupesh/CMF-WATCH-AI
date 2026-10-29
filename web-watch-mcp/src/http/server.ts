import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { Logger } from "../logger.js";
import { createMcpServer } from "../mcp-server.js";
import type { Runtime } from "../runtime.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import { OAuthService } from "./oauth.js";

export interface HttpServerHandle {
  server: Server;
  oauth: OAuthService;
  close(): Promise<void>;
}

export async function startHttpServer(
  runtime: Runtime,
  logger: Logger,
): Promise<HttpServerHandle> {
  if (!runtime.config.oauth) {
    throw new Error("HTTP mode requires OAuth configuration");
  }

  const oauth = new OAuthService(runtime.config, runtime.paths, logger.child("oauth"));
  await oauth.init();

  const app = express();
  app.disable("x-powered-by");
  const trustProxy = runtime.config.oauth.trustProxy;
  app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  const validateHost = hostHeaderValidation(runtime.config.oauth.allowedHosts);
  const validateOrigin = originValidation(runtime.config.oauth.allowedOriginHosts);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (runtime.config.oauth?.publicUrl.protocol === "https:") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    next();
  });

  app.use((req, res, next) => {
    if (!validateHost(req, res)) {
      return;
    }
    if (!validateOrigin(req, res)) {
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, MCP-Protocol-Version",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use((req, res, next) => {
    res.on("finish", () => {
      logger.debug("HTTP request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
      });
    });
    next();
  });

  app.get("/healthz", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mode: "http",
    });
  });

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 40,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "too_many_requests" },
  });

  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "too_many_requests" },
  });

  for (const authPath of ["/authorize", "/token", "/revoke", "/register"]) {
    app.use(authPath, authLimiter);
    app.use(authPath, express.urlencoded({ extended: false, limit: "64kb" }));
    app.use(authPath, express.json({ limit: "64kb" }));
  }

  app.use(oauth.router);

  const mcpHandler = createMcpHandler(() => createMcpServer(runtime), {
    maxRequestBodySize: runtime.config.limits.maxRequestBytes,
    onerror: (error) => {
      logger.error("MCP handler error", { error: error.message });
    },
  });

  const nodeHandler = toNodeHandler(mcpHandler, {
    maxRequestBodySize: runtime.config.limits.maxRequestBytes,
    onerror: (error) => {
      logger.error("MCP Node adapter error", { error: error.message });
    },
  });

  app.all(
    "/mcp",
    mcpLimiter,
    oauth.requireBearer(),
    express.json({
      limit: runtime.config.limits.maxRequestBytes,
      type: ["application/json", "application/*+json"],
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedBody = req.method === "POST" ? req.body : undefined;
        await nodeHandler(req, res, parsedBody);
      } catch (error) {
        next(error);
      }
    },
  );

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    logger.warn("HTTP request failed", {
      method: req.method,
      path: req.path,
      error: error instanceof Error ? error.message : String(error),
    });

    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 500;

    res.status(status).json({
      error: status >= 500 ? "internal_error" : "bad_request",
    });
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(
      runtime.config.http.port,
      runtime.config.http.host,
      () => resolve(listening),
    );
    listening.on("error", reject);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : runtime.config.http.port;
  logger.info("HTTP server listening", {
    host: runtime.config.http.host,
    port,
    publicUrl: runtime.config.oauth.publicUrl.href,
    mcpUrl: runtime.config.oauth.resourceUrl,
  });

  return {
    server,
    oauth,
    async close(): Promise<void> {
      await mcpHandler.close();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections(), 10_000);
        timer.unref();
        server.close(() => { clearTimeout(timer); resolve(); });
        server.closeIdleConnections();
      });
      await runtime.close();
    },
  };
}
