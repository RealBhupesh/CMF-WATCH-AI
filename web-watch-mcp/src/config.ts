import { resolve } from "node:path";
import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./logger.js";

export type ServerMode = "stdio" | "http";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const optionalNumber = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.coerce.number().optional(),
);

const rawSchema = z.object({
  DATA_DIR: z.string().default("data"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  BROWSER_HEADLESS: optionalString,
  BROWSER_CHANNEL: optionalString,
  BROWSER_SLOW_MO_MS: optionalNumber,
  BROWSER_TIMEOUT_MS: optionalNumber,
  BROWSER_PROFILE_DIR: optionalString,
  BROWSER_VIEWPORT_WIDTH: optionalNumber,
  BROWSER_VIEWPORT_HEIGHT: optionalNumber,
  BROWSER_MAX_TABS: optionalNumber,
  BROWSER_MAX_SESSIONS: optionalNumber,
  MCP_HTTP_HOST: optionalString,
  MCP_HTTP_PORT: optionalNumber,
  PORT: optionalNumber,
  RENDER_EXTERNAL_URL: optionalString,
  MCP_PUBLIC_URL: optionalString,
  MCP_OWNER_PASSWORD: optionalString,
  MCP_JWT_SECRET: optionalString,
  MCP_ALLOWED_HOSTS: optionalString,
  MCP_ALLOWED_ORIGINS: optionalString,
  MCP_TOKEN_TTL_SECONDS: optionalNumber,
  MCP_REFRESH_TTL_DAYS: optionalNumber,
  MCP_TRUST_PROXY: optionalString,
  MCP_MAX_REQUEST_BYTES: optionalNumber,
  MAX_UPLOAD_MB: optionalNumber,
  MAX_STORED_FILES_MB: optionalNumber,
  MAX_SNAPSHOT_ELEMENTS: optionalNumber,
  MAX_TEXT_CHARS: optionalNumber,
  CAPTCHA_POLICY: z.enum(["human"]).default("human"),
});

export interface BrowserConfig {
  headless: boolean;
  channel?: string;
  slowMoMs: number;
  timeoutMs: number;
  profileDir: string;
  viewport: { width: number; height: number };
  maxTabs: number;
  maxSessions: number;
}

export interface OAuthConfig {
  publicUrl: URL;
  resourceUrl: string;
  ownerPassword: string;
  jwtSecret: string;
  tokenTtlSeconds: number;
  refreshTtlSeconds: number;
  allowedHosts: string[];
  allowedOriginHosts: string[];
  trustProxy: string;
}

export interface LimitsConfig {
  maxUploadBytes: number;
  maxSnapshotElements: number;
  maxTextChars: number;
  maxRequestBytes: number;
  maxStoredFilesBytes: number;
}

export interface AppConfig {
  mode: ServerMode;
  dataDir: string;
  logLevel: LogLevel;
  browser: BrowserConfig;
  http: {
    host: string;
    port: number;
  };
  oauth?: OAuthConfig;
  limits: LimitsConfig;
  captchaPolicy: "human";
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new ConfigError(`Invalid boolean value: ${value}`);
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer`);
  }

  return value;
}

function nonNegativeNumber(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${label} must be a non-negative number`);
  }

  return value;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function requireHttpConfig(raw: z.infer<typeof rawSchema>): OAuthConfig {
  if (!raw.MCP_PUBLIC_URL) {
    throw new ConfigError(
      "MCP_PUBLIC_URL is required in HTTP mode. Use the public HTTPS URL of your tunnel, for example https://jobs.example.com",
    );
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(raw.MCP_PUBLIC_URL);
  } catch {
    throw new ConfigError("MCP_PUBLIC_URL must be a valid absolute URL");
  }

  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new ConfigError("MCP_PUBLIC_URL must be an origin without credentials, query, or fragment");
  }

  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
    throw new ConfigError("MCP_PUBLIC_URL must use HTTP or HTTPS");
  }

  if (publicUrl.pathname !== "/" && publicUrl.pathname !== "") {
    throw new ConfigError("MCP_PUBLIC_URL must not include a path");
  }

  publicUrl.pathname = "/";
  publicUrl.search = "";
  publicUrl.hash = "";

  const isLoopback =
    publicUrl.hostname === "localhost" ||
    publicUrl.hostname === "127.0.0.1" ||
    publicUrl.hostname === "[::1]";

  if (publicUrl.protocol !== "https:" && !isLoopback) {
    throw new ConfigError("MCP_PUBLIC_URL must use HTTPS unless it points at localhost");
  }

  if (!raw.MCP_OWNER_PASSWORD || raw.MCP_OWNER_PASSWORD.length < 12) {
    throw new ConfigError(
      "MCP_OWNER_PASSWORD is required in HTTP mode and must be at least 12 characters. Run npm run setup to generate one.",
    );
  }

  if (!raw.MCP_JWT_SECRET || raw.MCP_JWT_SECRET.length < 32) {
    throw new ConfigError(
      "MCP_JWT_SECRET is required in HTTP mode and must be at least 32 characters. Run npm run setup to generate one.",
    );
  }

  const defaultHosts = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    publicUrl.hostname.toLowerCase(),
  ];
  const configuredHosts = splitList(raw.MCP_ALLOWED_HOSTS);
  const allowedHosts = [...new Set([...defaultHosts, ...configuredHosts])];

  const defaultOriginHosts = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    publicUrl.hostname.toLowerCase(),
  ];
  const configuredOrigins = splitList(raw.MCP_ALLOWED_ORIGINS);
  const allowedOriginHosts = [...new Set([...defaultOriginHosts, ...configuredOrigins])];

  const resourceUrl = new URL("/mcp", publicUrl).href;

  return {
    publicUrl,
    resourceUrl,
    ownerPassword: raw.MCP_OWNER_PASSWORD,
    jwtSecret: raw.MCP_JWT_SECRET,
    tokenTtlSeconds: positiveInteger(raw.MCP_TOKEN_TTL_SECONDS, 3600, "MCP_TOKEN_TTL_SECONDS"),
    refreshTtlSeconds: positiveInteger(raw.MCP_REFRESH_TTL_DAYS, 30, "MCP_REFRESH_TTL_DAYS") * 86_400,
    allowedHosts,
    allowedOriginHosts,
    trustProxy: raw.MCP_TRUST_PROXY ?? "loopback",
  };
}

export function loadConfig(
  mode: ServerMode,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment configuration: ${parsed.error.message}`);
  }

  const raw = parsed.data;
  raw.MCP_PUBLIC_URL ??= raw.RENDER_EXTERNAL_URL;
  const dataDir = resolve(process.cwd(), raw.DATA_DIR);
  const port = positiveInteger(raw.MCP_HTTP_PORT ?? raw.PORT, 8787, "MCP_HTTP_PORT/PORT");
  if (port > 65535) throw new ConfigError("MCP_HTTP_PORT/PORT must be at most 65535");
  const profileDir = raw.BROWSER_PROFILE_DIR
    ? resolve(process.cwd(), raw.BROWSER_PROFILE_DIR)
    : resolve(dataDir, "browser-profile");

  const config: AppConfig = {
    mode,
    dataDir,
    logLevel: raw.LOG_LEVEL,
    browser: {
      headless: booleanValue(raw.BROWSER_HEADLESS, false),
      channel: raw.BROWSER_CHANNEL,
      slowMoMs: nonNegativeNumber(raw.BROWSER_SLOW_MO_MS, 0, "BROWSER_SLOW_MO_MS"),
      timeoutMs: positiveInteger(raw.BROWSER_TIMEOUT_MS, 30_000, "BROWSER_TIMEOUT_MS"),
      profileDir,
      maxTabs: positiveInteger(raw.BROWSER_MAX_TABS, 10, "BROWSER_MAX_TABS"),
      maxSessions: positiveInteger(raw.BROWSER_MAX_SESSIONS, 3, "BROWSER_MAX_SESSIONS"),
      viewport: {
        width: positiveInteger(raw.BROWSER_VIEWPORT_WIDTH, 1440, "BROWSER_VIEWPORT_WIDTH"),
        height: positiveInteger(raw.BROWSER_VIEWPORT_HEIGHT, 1000, "BROWSER_VIEWPORT_HEIGHT"),
      },
    },
    http: {
      host: raw.MCP_HTTP_HOST ?? (raw.RENDER_EXTERNAL_URL ? "0.0.0.0" : "127.0.0.1"),
      port,
    },
    limits: {
      maxUploadBytes:
        positiveInteger(raw.MAX_UPLOAD_MB, 10, "MAX_UPLOAD_MB") * 1024 * 1024,
      maxSnapshotElements: positiveInteger(
        raw.MAX_SNAPSHOT_ELEMENTS,
        200,
        "MAX_SNAPSHOT_ELEMENTS",
      ),
      maxTextChars: positiveInteger(raw.MAX_TEXT_CHARS, 20_000, "MAX_TEXT_CHARS"),
      maxRequestBytes: positiveInteger(
        raw.MCP_MAX_REQUEST_BYTES,
        Math.ceil(positiveInteger(raw.MAX_UPLOAD_MB, 10, "MAX_UPLOAD_MB") * 1024 * 1024 * 4 / 3) + 64 * 1024,
        "MCP_MAX_REQUEST_BYTES",
      ),
      maxStoredFilesBytes: positiveInteger(raw.MAX_STORED_FILES_MB, 500, "MAX_STORED_FILES_MB") * 1024 * 1024,
    },
    captchaPolicy: "human",
  };

  if (mode === "http") {
    config.oauth = requireHttpConfig(raw);
  }

  return config;
}
