import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type HttpServerHandle } from "../src/http/server.js";
import { Logger } from "../src/logger.js";
import { createRuntime } from "../src/runtime.js";

const OWNER_PASSWORD = "test-owner-password-123";
const JWT_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

let directory: string | undefined;
let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  handle = undefined;
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("HTTP OAuth", () => {
  it("completes discovery, registration, authorization, token, and refresh", async () => {
    const port = await freePort();
    directory = await mkdtemp(join(tmpdir(), "job-crawler-http-"));
    const config = loadConfig("http", {
      DATA_DIR: directory,
      MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(port),
      MCP_OWNER_PASSWORD: OWNER_PASSWORD,
      MCP_JWT_SECRET: JWT_SECRET,
      MCP_TRUST_PROXY: "1",
    });
    const logger = new Logger("error", "http-test");
    const runtime = await createRuntime(config, logger);
    handle = await startHttpServer(runtime, logger);
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);

    const metadataResponse = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(metadataResponse.status).toBe(200);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);

    const registrationResponse = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Test Client",
      }),
    });
    expect(registrationResponse.status).toBe(201);
    const registration = (await registrationResponse.json()) as { client_id: string };
    expect(registration.client_id).toMatch(/^mcp_/);

    const { verifier, challenge } = pkce();
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: REDIRECT_URI,
      state: "state-123",
      scope: "mcp",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${base}/mcp`,
    });

    const authorizePage = await fetch(`${base}/authorize?${authorizeParams.toString()}`);
    expect(authorizePage.status).toBe(200);
    expect(await authorizePage.text()).toContain("Owner password");

    const approvalBody = new URLSearchParams(authorizeParams);
    approvalBody.set("owner_password", OWNER_PASSWORD);
    const approval = await fetch(`${base}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: approvalBody.toString(),
      redirect: "manual",
    });
    expect(approval.status).toBe(302);
    const location = approval.headers.get("location");
    expect(location).toBeTruthy();
    const redirect = new URL(location as string);
    expect(redirect.searchParams.get("state")).toBe("state-123");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: REDIRECT_URI,
        client_id: registration.client_id,
        code_verifier: verifier,
        resource: `${base}/mcp`,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token.split(".")).toHaveLength(3);

    const mcpHeaders: Record<string, string> = {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(mcpResponse.status).toBe(200);
    const sessionId = mcpResponse.headers.get("mcp-session-id");
    if (sessionId) {
      mcpHeaders["mcp-session-id"] = sessionId;
    }

    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const listResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(listResponse.status).toBe(200);
    const tools = await listResponse.text();
    for (const name of ["browser_open", "browser_fill_form", "browser_check", "jobs_search", "application_reconcile"]) expect(tools).toContain(name);

    const statusResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "server_status", arguments: {} },
      }),
    });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.text()).toContain("captchaPolicy");

    const refreshResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: registration.client_id,
        resource: `${base}/mcp`,
      }).toString(),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as { access_token: string };
    expect(refreshed.access_token).not.toBe(tokens.access_token);
  });
});
