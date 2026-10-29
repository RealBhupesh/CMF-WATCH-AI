import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "169.254.169.254",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
];

export class UnsafeUrlError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface UrlGuardOptions {
  resolveDns?: boolean;
  timeoutMs?: number;
}

export async function assertSafeUrl(
  input: string | URL,
  options: UrlGuardOptions = {},
): Promise<URL> {
  const url = input instanceof URL ? new URL(input.href) : parseUrl(input);
  const rawHostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http and https URLs are allowed, received ${url.protocol}`, url.href);
  }

  if (hostname === "") {
    throw new UnsafeUrlError("URL has no hostname", url.href);
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed", url.href);
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new UnsafeUrlError(`Blocked private hostname: ${hostname}`, url.href);
  }

  if (isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
    throw new UnsafeUrlError(`Blocked private IP address: ${hostname}`, url.href);
  }

  if (options.resolveDns !== false) {
    await assertPublicDns(hostname, url.href, options.timeoutMs ?? 5_000);
  }

  return url;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPrivateIPv4(address);
  }
  if (version === 6) {
    return isPrivateIPv6(address);
  }
  return true;
}

function parseUrl(input: string): URL {
  try {
    return new URL(input);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${input}`, input);
  }
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;

  return false;
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];

  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isPrivateIPv4(mapped[1]);
  }

  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIPv4(
      `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
    );
  }

  return false;
}

async function assertPublicDns(hostname: string, url: string, timeoutMs: number): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await withTimeout(
      lookup(hostname, { all: true, verbatim: true }),
      timeoutMs,
      `DNS lookup timed out for ${hostname}`,
    );
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN")) {
      throw new UnsafeUrlError(`DNS lookup failed for ${hostname}`, url);
    }
    throw error;
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`DNS lookup returned no addresses for ${hostname}`, url);
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new UnsafeUrlError(
        `Blocked hostname ${hostname} because it resolves to private address ${entry.address}`,
        url,
      );
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
