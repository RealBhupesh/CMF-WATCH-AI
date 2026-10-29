import "dotenv/config";
import { randomBytes } from "node:crypto";
import { access, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

const envPath = join(process.cwd(), ".env");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (await exists(envPath)) {
    process.stderr.write(
      `Refusing to overwrite existing .env at ${envPath}. Edit it directly if you need to rotate secrets.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const ownerPassword = randomBytes(18).toString("base64url");
  const jwtSecret = randomBytes(48).toString("base64url");

  const contents = `# Local job-crawler MCP configuration.
# Replace MCP_PUBLIC_URL with the HTTPS hostname routed to your Cloudflare tunnel.
DATA_DIR=data
LOG_LEVEL=info
BROWSER_HEADLESS=false
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=8787
MCP_PUBLIC_URL=https://YOUR-DOMAIN.example.com
MCP_OWNER_PASSWORD=${ownerPassword}
MCP_JWT_SECRET=${jwtSecret}
# MCP_ALLOWED_HOSTS=
# MCP_ALLOWED_ORIGINS=
# MCP_TOKEN_TTL_SECONDS=3600
# MCP_REFRESH_TTL_DAYS=30
# MAX_UPLOAD_MB=10
# MAX_SNAPSHOT_ELEMENTS=200
# MAX_TEXT_CHARS=20000
`;

  await writeFile(envPath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600).catch(() => undefined);

  process.stderr.write(
    [
      `Created ${envPath}`,
      "",
      "Next steps:",
      "1. Replace MCP_PUBLIC_URL with the HTTPS hostname for your Cloudflare tunnel.",
      "2. Run: npm run tunnel:setup -- <tunnel-name> <public-hostname>",
      "3. Run: npm start",
      "4. Run cloudflared tunnel run <tunnel-name>",
      "5. Add the MCP connector URL in ChatGPT: <MCP_PUBLIC_URL>/mcp",
      "",
      "Owner password (needed when ChatGPT asks you to authorize the connector):",
      ownerPassword,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
