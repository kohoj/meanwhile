FROM docker.io/cloudflare/sandbox:0.12.3

RUN install -d -m 0755 /opt/meanwhile/agents /opt/meanwhile/bin /opt/meanwhile/licenses /tmp/meanwhile-bridge
COPY image/package.json image/bun.lock /opt/meanwhile/agents/
RUN cd /opt/meanwhile/agents && bun install --frozen-lockfile --production
COPY --chmod=0755 image/claude-agent-acp /opt/meanwhile/bin/claude-agent-acp
COPY --chmod=0755 image/codex-acp /opt/meanwhile/bin/codex-acp
COPY --chmod=0755 image/pi-acp /opt/meanwhile/bin/pi-acp
COPY --chmod=0755 image/pi-runtime /opt/meanwhile/bin/pi-runtime
COPY --chmod=0644 image/pi-settings.json /opt/meanwhile/pi/settings.json
COPY --chmod=0755 .runner/meanwhile-runner /opt/meanwhile/bin/meanwhile-runner
COPY --chmod=0755 .runner/meanwhile-demo-agent /opt/meanwhile/bin/meanwhile-demo-agent
COPY --chmod=0644 .runner/LICENSE .runner/THIRD_PARTY_NOTICES /opt/meanwhile/licenses/

ENV PATH="/opt/meanwhile/bin:${PATH}"

WORKDIR /workspace

# Port 3000 is reserved by the Sandbox runtime. This exposed development port
# is only for local preview-contract checks; production quick tunnels can use
# any validated non-reserved port.
EXPOSE 3001
