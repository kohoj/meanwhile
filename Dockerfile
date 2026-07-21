FROM oven/bun:1.3.13 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY providers/cloudflare-sandbox/package.json providers/cloudflare-sandbox/package.json
COPY board/package.json board/package.json
COPY src ./src
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.13 AS runner
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY providers/cloudflare-sandbox/package.json providers/cloudflare-sandbox/package.json
COPY board/package.json board/package.json
COPY src ./src
RUN bun install --frozen-lockfile
COPY runner ./runner
COPY test/fixtures/acp-agent.ts ./test/fixtures/acp-agent.ts
RUN bun build runner/main.ts --compile --minify --outfile /meanwhile-runner
RUN bun build test/fixtures/acp-agent.ts --compile --minify --outfile /meanwhile-demo-agent

FROM runner AS board
COPY src ./src
COPY board/src ./board/src
RUN bun run --cwd board build

FROM oven/bun:1.3.13-slim
LABEL org.opencontainers.image.title="Meanwhile" \
    org.opencontainers.image.description="Open control plane for coding agents in isolated runtimes" \
    org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    MEANWHILE_HOST=0.0.0.0 \
    MEANWHILE_PORT=7331 \
    MEANWHILE_DATA_DIR=/data/state \
    MEANWHILE_RUNNER_PATH=/usr/local/bin/meanwhile-runner
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/board/node_modules ./board/node_modules
COPY package.json ./
COPY src ./src
COPY runner/protocol.ts ./runner/protocol.ts
COPY providers/cloudflare-sandbox/src/protocol.ts ./providers/cloudflare-sandbox/src/protocol.ts
COPY config ./config
COPY board/package.json ./board/package.json
COPY board/src ./board/src
COPY --from=board /app/board/dist ./board/dist
COPY LICENSE THIRD_PARTY_NOTICES /usr/share/doc/meanwhile/
COPY --from=runner /meanwhile-runner /usr/local/bin/meanwhile-runner
COPY --from=runner /meanwhile-demo-agent /usr/local/bin/meanwhile-demo-agent
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
EXPOSE 7331 7332 7333
VOLUME ["/data"]
CMD ["bun", "src/server.ts"]
