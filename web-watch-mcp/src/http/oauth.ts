import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Request, RequestHandler, Response, Router } from "express";
import { Router as createRouter } from "express";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { AppConfig, OAuthConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AppPaths } from "../paths.js";
import { JsonFile } from "../storage/json-file.js";

const clientSchema = z.object({
  clientId: z.string(),
  clientSecretHash: z.string().optional(),
  clientName: z.string().optional(),
  redirectUris: z.array(z.string()),
  grantTypes: z.array(z.string()),
  responseTypes: z.array(z.string()),
  tokenEndpointAuthMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]),
  createdAt: z.string(),
});

type OAuthClient = z.infer<typeof clientSchema>;

const clientFileSchema = z.object({
  clients: z.array(clientSchema).default([]),
});

const refreshTokenSchema = z.object({
  tokenHash: z.string(),
  clientId: z.string(),
  scope: z.string(),
  expiresAt: z.number().int(),
  createdAt: z.string(),
});

const refreshFileSchema = z.object({
  tokens: z.array(refreshTokenSchema).default([]),
});

const revokedSchema = z.object({
  tokens: z.array(
    z.object({
      jti: z.string(),
      expiresAt: z.number().int(),
      revokedAt: z.string(),
    }),
  ).default([]),
});

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

const authorizeRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  state: z.string().optional(),
  scope: z.string().optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  resource: z.string().optional(),
});

const registrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_post", "client_secret_basic"])
    .optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_name: z.string().max(200).optional(),
  scope: z.string().optional(),
});

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description: string,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

export class OAuthService {
  readonly router: Router;

  private readonly config: OAuthConfig;
  private readonly clients: JsonFile<z.infer<typeof clientFileSchema>>;
  private readonly refreshTokens: JsonFile<z.infer<typeof refreshFileSchema>>;
  private readonly revokedTokens: JsonFile<z.infer<typeof revokedSchema>>;
  private readonly revokedSet = new Set<string>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly signingKey: Uint8Array;
  private readonly issuer: string;
  private readonly resourceMetadataUrl: string;

  constructor(
    appConfig: AppConfig,
    paths: AppPaths,
    private readonly logger: Logger,
  ) {
    if (!appConfig.oauth) {
      throw new Error("OAuth service requires HTTP mode configuration");
    }

    this.config = appConfig.oauth;
    this.issuer = this.config.publicUrl.origin;
    this.resourceMetadataUrl = this.absolute("/.well-known/oauth-protected-resource");
    this.signingKey = new TextEncoder().encode(this.config.jwtSecret);
    this.clients = new JsonFile(paths.oauthClientsFile, clientFileSchema, () => ({ clients: [] }));
    this.refreshTokens = new JsonFile(paths.oauthRefreshTokensFile, refreshFileSchema, () => ({
      tokens: [],
    }));
    this.revokedTokens = new JsonFile(paths.oauthRevokedFile, revokedSchema, () => ({ tokens: [] }));
    this.router = this.buildRouter();
  }

  async init(): Promise<void> {
    const revoked = await this.revokedTokens.read();
    const now = Math.floor(Date.now() / 1000);
    for (const token of revoked.tokens) {
      if (token.expiresAt > now) {
        this.revokedSet.add(token.jti);
      }
    }
  }

  requireBearer(): RequestHandler {
    return async (req, res, next) => {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        this.sendChallenge(res, "invalid_token", "A bearer token is required");
        return;
      }

      const token = header.slice("Bearer ".length).trim();
      try {
        const { payload } = await jwtVerify(token, this.signingKey, {
          issuer: this.issuer,
          audience: this.config.resourceUrl,
          algorithms: ["HS256"],
        });

        const jti = typeof payload.jti === "string" ? payload.jti : undefined;
        if (jti && this.revokedSet.has(jti)) {
          this.sendChallenge(res, "invalid_token", "The token has been revoked");
          return;
        }

        const clientId = typeof payload.client_id === "string" ? payload.client_id : "";
        const scope = typeof payload.scope === "string" ? payload.scope : "mcp";
        const authInfo: AuthInfo = {
          token,
          clientId,
          scopes: scope.split(/\s+/).filter(Boolean),
          expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
          resource: new URL(this.config.resourceUrl),
          resourceMetadataUrl: this.resourceMetadataUrl,
        };

        (req as Request & { auth?: AuthInfo }).auth = authInfo;
        next();
      } catch (error) {
        this.logger.debug("Bearer token rejected", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.sendChallenge(res, "invalid_token", "The access token is invalid or expired");
      }
    };
  }

  private buildRouter(): Router {
    const router = createRouter();

    router.get("/.well-known/oauth-protected-resource", (req, res) => {
      this.cors(res);
      res.json(this.protectedResourceMetadata());
    });

    router.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
      this.cors(res);
      res.json(this.protectedResourceMetadata());
    });

    router.get("/.well-known/oauth-authorization-server", (req, res) => {
      this.cors(res);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(this.authorizationServerMetadata());
    });

    router.get("/.well-known/openid-configuration", (req, res) => {
      this.cors(res);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.json(this.authorizationServerMetadata());
    });

    router.post("/register", async (req, res) => {
      try {
        const parsed = registrationSchema.safeParse(req.body);
        if (!parsed.success) {
          this.tokenError(res, new OAuthError(400, "invalid_client_metadata", parsed.error.message));
          return;
        }

        for (const redirectUri of parsed.data.redirect_uris) {
          if (!isAllowedRedirectUri(redirectUri)) {
            this.tokenError(
              res,
              new OAuthError(400, "invalid_redirect_uri", `Redirect URI is not allowed: ${redirectUri}`),
            );
            return;
          }
        }

        const method = parsed.data.token_endpoint_auth_method ?? "client_secret_post";
        const clientId = `mcp_${randomBytes(16).toString("hex")}`;
        const clientSecret =
          method === "none" ? undefined : `mcp_secret_${randomBytes(32).toString("base64url")}`;

        const client: OAuthClient = {
          clientId,
          clientSecretHash: clientSecret ? sha256(clientSecret) : undefined,
          clientName: parsed.data.client_name,
          redirectUris: parsed.data.redirect_uris,
          grantTypes: parsed.data.grant_types ?? ["authorization_code", "refresh_token"],
          responseTypes: parsed.data.response_types ?? ["code"],
          tokenEndpointAuthMethod: method,
          createdAt: new Date().toISOString(),
        };

        await this.clients.update((current) => ({ clients: [...current.clients, client] }));

        res.status(201).json({
          client_id: clientId,
          client_secret: clientSecret,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret_expires_at: 0,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          grant_types: client.grantTypes,
          response_types: client.responseTypes,
          client_name: client.clientName,
        });
      } catch (error) {
        this.logger.error("Client registration failed", { error: String(error) });
        this.tokenError(res, new OAuthError(500, "server_error", "Client registration failed"));
      }
    });

    router.get("/authorize", async (req, res) => {
      await this.handleAuthorizeGet(req, res);
    });

    router.post("/authorize", async (req, res) => {
      await this.handleAuthorizePost(req, res);
    });

    router.post("/token", async (req, res) => {
      try {
        const response = await this.handleToken(req);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        res.json(response);
      } catch (error) {
        if (error instanceof OAuthError) {
          this.tokenError(res, error);
          return;
        }
        this.logger.error("Token request failed", { error: String(error) });
        this.tokenError(res, new OAuthError(500, "server_error", "Token request failed"));
      }
    });

    router.post("/revoke", async (req, res) => {
      try {
        await this.handleRevoke(req);
        res.status(200).json({});
      } catch (error) {
        this.logger.warn("Token revocation failed", { error: String(error) });
        res.status(200).json({});
      }
    });

    return router;
  }

  private async handleAuthorizeGet(req: Request, res: Response): Promise<void> {
    const query = requestParams(req.query);
    const client = await this.findClient(query.client_id);
    if (!client) {
      this.htmlError(res, 400, "Unknown client", "The OAuth client is not registered.");
      return;
    }

    if (!query.redirect_uri || !client.redirectUris.includes(query.redirect_uri)) {
      this.htmlError(res, 400, "Invalid redirect URI", "The redirect URI is not registered for this client.");
      return;
    }

    const parsed = authorizeRequestSchema.safeParse(query);
    if (!parsed.success) {
      this.redirectError(
        res,
        query.redirect_uri,
        query.state,
        "invalid_request",
        parsed.error.message,
      );
      return;
    }

    const scope = this.validateScope(parsed.data.scope);
    if (scope instanceof OAuthError) {
      this.redirectError(res, query.redirect_uri, query.state, scope.code, scope.message);
      return;
    }

    if (parsed.data.resource && parsed.data.resource !== this.config.resourceUrl) {
      this.redirectError(
        res,
        query.redirect_uri,
        query.state,
        "invalid_target",
        "The requested resource does not match this MCP server",
      );
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(this.renderAuthorizePage(parsed.data, client, undefined));
  }

  private async handleAuthorizePost(req: Request, res: Response): Promise<void> {
    const body = requestParams(req.body);
    const client = await this.findClient(body.client_id);
    if (!client) {
      this.htmlError(res, 400, "Unknown client", "The OAuth client is not registered.");
      return;
    }

    if (!body.redirect_uri || !client.redirectUris.includes(body.redirect_uri)) {
      this.htmlError(res, 400, "Invalid redirect URI", "The redirect URI is not registered for this client.");
      return;
    }

    const parsed = authorizeRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.redirectError(
        res,
        body.redirect_uri,
        body.state,
        "invalid_request",
        parsed.error.message,
      );
      return;
    }

    const scope = this.validateScope(parsed.data.scope);
    if (scope instanceof OAuthError) {
      this.redirectError(res, body.redirect_uri, body.state, scope.code, scope.message);
      return;
    }

    if (parsed.data.resource && parsed.data.resource !== this.config.resourceUrl) {
      this.redirectError(
        res,
        body.redirect_uri,
        body.state,
        "invalid_target",
        "The requested resource does not match this MCP server",
      );
      return;
    }

    if (!safeEqual(body.owner_password ?? "", this.config.ownerPassword)) {
      this.logger.warn("Rejected OAuth authorization attempt");
      res.setHeader("Cache-Control", "no-store");
      res
        .status(401)
        .type("html")
        .send(this.renderAuthorizePage(parsed.data, client, "Incorrect owner password."));
      return;
    }

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      code,
      clientId: client.clientId,
      redirectUri: parsed.data.redirect_uri,
      codeChallenge: parsed.data.code_challenge,
      scope,
      expiresAt: Date.now() + 5 * 60_000,
    });

    const redirect = new URL(parsed.data.redirect_uri);
    redirect.searchParams.set("code", code);
    if (parsed.data.state) {
      redirect.searchParams.set("state", parsed.data.state);
    }

    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, redirect.href);
  }

  private async handleToken(req: Request): Promise<TokenResponse> {
    const body = requestParams(req.body);
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const client = await this.authenticateClient(req, body);
      const codeValue = required(body.code, "code");
      const redirectUri = required(body.redirect_uri, "redirect_uri");
      const codeVerifier = required(body.code_verifier, "code_verifier");

      this.cleanupCodes();
      const code = this.codes.get(codeValue);
      if (!code || code.expiresAt < Date.now()) {
        throw new OAuthError(400, "invalid_grant", "The authorization code is invalid or expired");
      }
      if (code.clientId !== client.clientId) {
        throw new OAuthError(400, "invalid_grant", "The authorization code was issued to another client");
      }
      if (code.redirectUri !== redirectUri) {
        throw new OAuthError(400, "invalid_grant", "The redirect URI does not match");
      }
      if (!verifyPkce(codeVerifier, code.codeChallenge)) {
        throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
      }

      this.codes.delete(codeValue);
      return this.issueTokens(client, code.scope);
    }

    if (grantType === "refresh_token") {
      const client = await this.authenticateClient(req, body);
      const refreshToken = required(body.refresh_token, "refresh_token");
      const hash = sha256(refreshToken);
      const now = Math.floor(Date.now() / 1000);
      const current = await this.refreshTokens.read();
      const record = current.tokens.find(
        (token) => token.tokenHash === hash && token.clientId === client.clientId,
      );

      if (!record || record.expiresAt <= now) {
        throw new OAuthError(400, "invalid_grant", "The refresh token is invalid or expired");
      }

      await this.refreshTokens.update((value) => ({
        tokens: value.tokens.filter((token) => token.tokenHash !== hash),
      }));

      return this.issueTokens(client, record.scope);
    }

    throw new OAuthError(400, "unsupported_grant_type", "Unsupported grant type");
  }

  private async handleRevoke(req: Request): Promise<void> {
    const body = requestParams(req.body);
    const token = body.token;
    if (!token) {
      return;
    }

    const refreshHash = sha256(token);
    await this.refreshTokens.update((current) => ({
      tokens: current.tokens.filter((entry) => entry.tokenHash !== refreshHash),
    }));

    try {
      const { payload } = await jwtVerify(token, this.signingKey, {
        issuer: this.issuer,
        audience: this.config.resourceUrl,
        algorithms: ["HS256"],
      });

      const jti = typeof payload.jti === "string" ? payload.jti : undefined;
      const expiresAt = typeof payload.exp === "number" ? payload.exp : undefined;
      if (jti && expiresAt) {
        this.revokedSet.add(jti);
        await this.revokedTokens.update((current) => ({
          tokens: [
            ...current.tokens.filter((entry) => entry.expiresAt > Math.floor(Date.now() / 1000)),
            { jti, expiresAt, revokedAt: new Date().toISOString() },
          ],
        }));
      }
    } catch {
      // RFC 7009 requires a successful response even for unknown tokens.
    }
  }

  private async issueTokens(client: OAuthClient, scope: string): Promise<TokenResponse> {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = this.config.tokenTtlSeconds;
    const jti = randomUUID();

    const accessToken = await new SignJWT({
      sub: "owner",
      client_id: client.clientId,
      scope,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience(this.config.resourceUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .setJti(jti)
      .sign(this.signingKey);

    const refreshToken = randomBytes(32).toString("base64url");
    await this.refreshTokens.update((current) => ({
      tokens: [
        ...current.tokens.filter((token) => token.expiresAt > now),
        {
          tokenHash: sha256(refreshToken),
          clientId: client.clientId,
          scope,
          expiresAt: now + this.config.refreshTtlSeconds,
          createdAt: new Date().toISOString(),
        },
      ],
    }));

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope,
    };
  }

  private async authenticateClient(req: Request, body: Record<string, string>): Promise<OAuthClient> {
    const basic = parseBasicAuth(req.headers.authorization);
    const clientId = basic?.clientId ?? body.client_id;
    if (!clientId) {
      throw new OAuthError(401, "invalid_client", "Client authentication is required");
    }

    const client = await this.findClient(clientId);
    if (!client) {
      throw new OAuthError(401, "invalid_client", "Unknown client");
    }

    if (basic && body.client_id && body.client_id !== basic.clientId) {
      throw new OAuthError(401, "invalid_client", "Client id mismatch");
    }

    if (client.tokenEndpointAuthMethod === "none") {
      return client;
    }

    const providedSecret = basic?.clientSecret ?? body.client_secret;
    if (!providedSecret) {
      throw new OAuthError(401, "invalid_client", "Client secret is required");
    }

    if (!client.clientSecretHash || !safeEqual(sha256(providedSecret), client.clientSecretHash)) {
      throw new OAuthError(401, "invalid_client", "Client secret is invalid");
    }

    return client;
  }

  private async findClient(clientId: string | undefined): Promise<OAuthClient | undefined> {
    if (!clientId) {
      return undefined;
    }
    const current = await this.clients.read();
    return current.clients.find((client) => client.clientId === clientId);
  }

  private validateScope(requested: string | undefined): string | OAuthError {
    const scopes = (requested ?? "mcp").split(/\s+/).filter(Boolean);
    if (scopes.length === 0) {
      return "mcp";
    }
    if (scopes.some((scope) => scope !== "mcp")) {
      return new OAuthError(400, "invalid_scope", "Only the mcp scope is supported");
    }
    return "mcp";
  }

  private cleanupCodes(): void {
    const now = Date.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt < now) {
        this.codes.delete(code);
      }
    }
  }

  private authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.absolute("/authorize"),
      token_endpoint: this.absolute("/token"),
      registration_endpoint: this.absolute("/register"),
      revocation_endpoint: this.absolute("/revoke"),
      scopes_supported: ["mcp"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      code_challenge_methods_supported: ["S256"],
    };
  }

  private protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.resourceUrl,
      authorization_servers: [this.issuer],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      resource_name: "Job Crawler MCP",
    };
  }

  private renderAuthorizePage(
    request: z.infer<typeof authorizeRequestSchema>,
    client: OAuthClient,
    error: string | undefined,
  ): string {
    const hidden = [
      ["response_type", request.response_type],
      ["client_id", request.client_id],
      ["redirect_uri", request.redirect_uri],
      ["state", request.state],
      ["scope", request.scope],
      ["code_challenge", request.code_challenge],
      ["code_challenge_method", request.code_challenge_method],
      ["resource", request.resource],
    ]
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
      )
      .join("\n");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Job Crawler MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f1ea; color: #1d1d1b; }
  main { width: min(92vw, 420px); background: #fffdf8; border: 1px solid #d8d2c4; border-radius: 18px; padding: 32px; box-shadow: 0 20px 60px rgba(40, 35, 25, 0.12); }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  p { line-height: 1.5; color: #555047; }
  .client { font-weight: 600; color: #1d1d1b; }
  label { display: block; font-weight: 600; margin: 22px 0 8px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 12px 14px; border: 1px solid #b8b0a0; border-radius: 10px; font: inherit; background: #fff; }
  button { width: 100%; margin-top: 18px; padding: 12px 16px; border: 0; border-radius: 10px; background: #1d1d1b; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .error { background: #fbe9e7; border: 1px solid #e2b8b0; color: #7a2418; padding: 10px 12px; border-radius: 10px; }
  .hint { font-size: 0.85rem; color: #7a7468; }
</style>
</head>
<body>
<main>
  <h1>Authorize Job Crawler MCP</h1>
  <p><span class="client">${escapeHtml(client.clientName ?? client.clientId)}</span> is requesting access to the local job-application browser.</p>
  <p class="hint">Enter the owner password from the server's <code>.env</code> file. This approval is required because the server can fill and submit job applications.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/authorize">
    ${hidden}
    <label for="owner_password">Owner password</label>
    <input id="owner_password" name="owner_password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Authorize</button>
  </form>
</main>
</body>
</html>`;
  }

  private sendChallenge(res: Response, error: string, description: string): void {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${this.resourceMetadataUrl}", scope="mcp", error="${error}", error_description="${description.replace(/"/g, "'")}"`,
    );
    res.status(401).json({ error, error_description: description });
  }

  private tokenError(res: Response, error: OAuthError): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    if (error.status === 401) {
      res.setHeader("WWW-Authenticate", 'Basic realm="job-crawler-mcp"');
    }
    res.status(error.status).json({
      error: error.code,
      error_description: error.message,
    });
  }

  private redirectError(
    res: Response,
    redirectUri: string,
    state: string | undefined,
    error: string,
    description: string,
  ): void {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) {
      url.searchParams.set("state", state);
    }
    res.redirect(302, url.href);
  }

  private htmlError(res: Response, status: number, title: string, message: string): void {
    res
      .status(status)
      .type("html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
      );
  }

  private cors(res: Response): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  }

  private absolute(path: string): string {
    return new URL(path, `${this.issuer}/`).href;
  }
}

function requestParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      output[key] = entry;
    } else if (Array.isArray(entry) && typeof entry[0] === "string") {
      output[key] = entry[0];
    }
  }
  return output;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new OAuthError(400, "invalid_request", `Missing required parameter: ${name}`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
    return false;
  }
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | undefined {
  if (!header?.startsWith("Basic ")) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return undefined;
    }
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
}

function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol === "https:") {
    return true;
  }

  if (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    return true;
  }

  if (["javascript:", "data:", "file:", "blob:"].includes(url.protocol)) {
    return false;
  }

  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
