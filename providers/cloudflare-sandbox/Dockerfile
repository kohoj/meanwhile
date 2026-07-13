FROM docker.io/cloudflare/sandbox:0.12.3

RUN install -d -m 0755 /opt/meanwhile/bin /opt/meanwhile/licenses /tmp/meanwhile-bridge
COPY --chmod=0755 .runner/meanwhile-runner /opt/meanwhile/bin/meanwhile-runner
COPY --chmod=0755 .runner/meanwhile-demo-agent /opt/meanwhile/bin/meanwhile-demo-agent
COPY --chmod=0644 .runner/LICENSE .runner/THIRD_PARTY_NOTICES /opt/meanwhile/licenses/

ENV PATH="/opt/meanwhile/bin:${PATH}"

WORKDIR /workspace

# Port 3000 is reserved by the Sandbox runtime. This exposed development port
# is only for local preview-contract checks; production quick tunnels can use
# any validated non-reserved port.
EXPOSE 3001
