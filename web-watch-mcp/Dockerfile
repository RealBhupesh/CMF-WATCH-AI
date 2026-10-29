FROM node:22-bookworm-slim AS build

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini gosu \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

RUN npx playwright install --with-deps chromium && chmod -R 755 /ms-playwright

COPY --from=build /app/dist ./dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod 755 /usr/local/bin/docker-entrypoint && mkdir -p /app/data && chown node:node /app/data

# The entrypoint prepares mounted disk ownership, then drops privileges to node.

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV MCP_HTTP_HOST=0.0.0.0
ENV BROWSER_HEADLESS=true
ENV PORT=8788

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||process.env.PORT||8788)+'/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint"]
CMD ["node", "dist/index.js", "--http"]
