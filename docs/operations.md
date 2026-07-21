# Operations

This document defines the implemented operating contract for Meanwhile's single-control-plane topology. Run the referenced checks on the exact revision before operating it. [AGENTS.md](../AGENTS.md) remains the source of architectural invariants.

## Supported topology

```text
one active Meanwhile control plane
    ├── one SQLite database on durable local storage
    ├── one owner-scoped artifact tree on durable local storage
    ├── local runtime directories, when local provider is enabled
    ├── separate-origin local preview server
    └── zero or more remote provider bridges
```

SQLite deliberately means **one active writer**. Multiple API processes against the same database are not a high-availability mode. Horizontal control-plane scale requires a shared lease-capable store and is an architectural change.

The local runtime provider executes directly on the host. It is not isolation and is inappropriate for untrusted code.

## Configuration

Bun loads local `.env` files for development. Production should inject environment variables through the process supervisor or secret platform rather than shipping an `.env` file in an image.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MEANWHILE_HOST` | No | API bind address; default target is loopback |
| `MEANWHILE_PORT` | No | API port; default target is `7331` |
| `MEANWHILE_PREVIEW_HOST` | No | Separate local preview bind address |
| `MEANWHILE_PREVIEW_PORT` | No | Separate local preview port; default target is `7332` |
| `MEANWHILE_PREVIEW_PUBLIC_URL` | For wildcard preview binds | Browser-facing HTTP(S) origin recorded in deployments; no credentials or path |
| `MEANWHILE_DATA_DIR` | Yes in production | Root for SQLite, artifacts, local runtime state, and other durable local data |
| `MEANWHILE_LOG_LEVEL` | No | Bounded structured-log threshold |
| `MEANWHILE_API_KEY` | Local bootstrap only | Initial development owner key; never the production key lifecycle |
| `MEANWHILE_RUNNER_PATH` | Yes outside source development | Fixed standalone runner executable |
| `MEANWHILE_AGENT_CATALOG` | No | Agent catalog path; defaults to `config/agents.json` |
| `MEANWHILE_DEFAULT_PROVIDER` | No | Registry name used when a request omits an allowed provider |
| `MEANWHILE_RUN_CONCURRENCY` | No | Maximum concurrently admitted one-shot executions; defaults to `2` |
| `MEANWHILE_SESSION_CONCURRENCY` | No | Maximum concurrently admitted new session leases and session cleanup operations; defaults to `2`; already-live sessions are always reattached during recovery |
| `MEANWHILE_LOCAL_PROVIDER` | No | `auto`, `enabled`, or `disabled`; `auto` admits new local runs only for a loopback API host while the internal adapter remains available for cleanup/reconciliation |
| `MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER` | Only for explicit non-loopback local execution | Acknowledges that authenticated tenants can execute as the control-plane OS user |
| `MEANWHILE_SECRET_ENV_ALLOWLIST` | For local-bootstrap `env://` sources | Comma-separated validated names available only to the bootstrap owner; source and target must match, reserved names are forbidden, and empty denies all |
| `MEANWHILE_OTEL_ENABLED` | No | Explicitly enables the tested OTel SDK/export path |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | When OTel enabled | OTLP/HTTP collector endpoint; no credentials in the URL |
| `CLOUDFLARE_BRIDGE_URL` | For Cloudflare | Deployed bridge base URL |
| `CLOUDFLARE_BRIDGE_TOKEN` | For Cloudflare | High-entropy bridge credential |
| `CLOUDFLARE_RUNNER_DIGEST` | For complete Cloudflare provenance | Operator-verified SHA-256 of the runner installed in the deployed runtime image |
| `CLOUDFLARE_RUNTIME_IMAGE_REFERENCE` | For complete Cloudflare provenance | Reference naming the deployed custom runtime image paired with the digest below |
| `CLOUDFLARE_RUNTIME_IMAGE_DIGEST` | For complete Cloudflare provenance | Platform-reported SHA-256 of that exact custom runtime image |

The complete safe template is [.env.example](../.env.example). Invalid recognized values, ports, catalog entries, default-provider selection, and endpoints fail validation rather than falling back silently. An explicit unknown provider on run creation is rejected before input or run persistence.

Any variable referenced through `env://NAME` is secret source material, not ordinary configuration. It must not be emitted by `doctor`, health, logs, telemetry, audit, or error output. For agent runs/sessions, a mediating provider keeps the source value outside compute and exposes only a revocable placeholder; a provider without that boundary rejects admission. The environment catalog is deliberately single-owner; provisioned tenants need a tenant-scoped secret-manager adapter. Checkout credentials additionally require repository-host binding and are therefore unsupported by this environment source.

## Durable data

`MEANWHILE_DATA_DIR` is one backup and ownership unit. The implementation derives internal database, artifact, preview, and local-runtime paths beneath it; operators should not configure competing locations.

Properties:

- SQLite contains relational state and artifact references, never artifact bodies or resolved secret values.
- Artifact objects are immutable and content-addressed.
- Runtime working directories are disposable even when located beneath the data root.
- Audit, run/session event journals, run logs, status history, deployments, and both runtime cleanup lifecycles survive service restart.
- Preview output is derived from immutable artifacts; it is not a second source of truth.
- An adjacent lease directory keyed by physical data-root identity is the single-writer authority for both the service and maintenance commands; a symlink alias cannot acquire a second lease.

Set restrictive filesystem ownership for the service account. The control plane needs read/write access to the data root and execute access to the runner. Other users should have no access. Do not place the data root inside a repository workspace.

## Startup

The startup order is:

1. validate environment configuration and initialize telemetry before application composition;
2. create the data root, acquire its exclusive lease, open SQLite, and initialize or verify the exact current schema;
3. bootstrap the optional local identity and validate the agent catalog;
4. compose provider, artifact, and deployment registries and require the configured default provider to exist;
5. start reconciliation, execution, deployment, and cleanup supervisors;
6. bind the Bun HTTP server and expose readiness.

Invalid configuration, data-root ownership, schema identity, catalog data, registry collisions, or an unknown default provider fail startup. The preview listener starts lazily on the first local-static deployment and resumes automatically when persisted successful previews exist. Runner availability is always an explicit `doctor` check. Catalog agent executables are host-checked only when the local provider admits new runs; remote toolchains are an image and live-provider proof concern. A missing executable never masquerades as startup health and causes the affected run to fail with durable evidence.

Development target:

```console
bun install
cp .env.example .env
bun -e 'import { issueApiKey } from "./src/auth.ts"; console.log("MEANWHILE_API_KEY=" + (await issueApiKey()).key)' >> .env
bun run runtime:build
bun run doctor
bun run dev
```

Persistent container target:

```console
export MEANWHILE_API_KEY='<local bootstrap key>'
docker compose up --build
```

Mount the ownership parent of `MEANWHILE_DATA_DIR` on durable storage and ensure the container's service user owns it. The supplied image mounts `/data` and places the actual root at `/data/state`, so the adjacent `/data/state.lock` lease stays inside the same writable, durable ownership volume without becoming part of the replaceable data root. The supplied Compose topology publishes API and preview ports on host loopback only. It deliberately sets `MEANWHILE_LOCAL_PROVIDER=enabled` and `MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER=true` because container-internal listeners bind all interfaces; it is for trusted local work and must not be exposed to untrusted tenants.

Compose also starts Project Watch on host loopback port 7333. The Board process
holds no API key and no database connection; it exchanges each person's API
key once with the private control plane and returns an opaque read-only session
in an HttpOnly SameSite cookie. To serve people in different locations, place a
host-level HTTPS reverse proxy in front of `127.0.0.1:7333`. Publish only the
Board origin. Keep 7331 and 7332 private, preserve `X-Forwarded-Proto: https`,
and do not configure `MEANWHILE_API_KEY` on the Project Watch service in team
mode.

`compose.yaml` optionally reads `${MEANWHILE_ENV_FILE:-./compose.env}`. Copy [compose.env.example](../compose.env.example) for Cloudflare bridge settings or local-bootstrap agent secret values named by `MEANWHILE_SECRET_ENV_ALLOWLIST`. The file is ignored by Git and Docker build context. It is not required by shell-only Bun workflows, and production should use an owner-scoped secret broker rather than a plaintext process environment.

## Shared Project release proof

The collaboration proof launches the production control-plane and Board entry
points on ephemeral local ports. It creates Alice, Bob, and Carol as distinct
Principals; proves Alice/Bob visibility and Carol isolation; exercises Project
Watch through two independent cookie sessions; rejects cross-member lifecycle
control; rotates Alice's API key; removes Bob; restarts; backs up; restores; and
rechecks current authorization and durable attribution. Exact plaintext
credentials are byte-scanned out of the live root, backup, and restored root.

```console
bun run proof:project-collaboration
bun run proof:project-collaboration:verify -- \
  .proof/project-collaboration.json \
  --require-clean \
  --commit="$(git rev-parse HEAD)"
```

The first command may run on a dirty tree for diagnosis, but its receipt records
`dirty: true`. Only the second command with both clean-revision gates upgrades
the result to collaboration release evidence.

## Shutdown and restart

On a normal shutdown the Bun HTTP server stops first, then the control-plane supervisors stop, the separate preview listener closes, telemetry flushes and shuts down while its durable gauges can still read SQLite, SQLite closes, and the data-root lease releases last. Each supervisor owns the safe termination or handoff of work it has already claimed; shutdown does not reinterpret an unfinished run as an agent failure.

Do not cancel active remote agents merely because the API process is restarting. Persisted runtime/process handles and cursors allow startup reconciliation when the provider supports it. Local child processes need explicit supervisor semantics and must not be assumed recoverable merely because a PID was stored.

After an unclean restart:

- queued runs remain eligible;
- terminal runs remain immutable;
- provisioning/running runs are inspected and replayed from persisted cursors;
- active one-shot runner sessions reconnect where supported;
- durable agent sessions reconnect to the same process and ACP identity where provider input/replay/recovery capabilities permit;
- exited one-shot and durable sessions finalize from accepted runner evidence and process facts; an unrecoverable durable session becomes `continuity_lost`;
- missing or irrecoverable compute becomes `RUNTIME_LOST` after bounded reconciliation;
- pending deployments and runtime cleanup resume from durable state.

The existing public run status remains authoritative while reconciliation is uncertain. Do not invent a public `recovering` status.

## Health and diagnostics

| Surface | Intended question |
| --- | --- |
| `GET /healthz` | Is the process alive enough to answer? |
| `GET /readyz` | Can this instance safely serve its configured control-plane role? |
| `bun run doctor` | Is a complete deployment configuration internally consistent? |
| `POST /providers/test` | Can an authorized owner test one registered provider through normalized diagnostics? |
| Structured logs | Which boundary, identifier, decision, and safe failure context explains an event? |
| Metrics/traces | Is behavior degrading across runs or provider operations? |

`/readyz` gates admission on control-plane supervisor availability and reports telemetry health without making optional exporter health authoritative. Configuration, schema, catalog, registry, and default-provider failures prevent startup. Runner binaries, agent executables, storage writability, and provider reachability belong to the deeper `doctor` diagnostic rather than a per-request dependency probe.

`doctor` validates environment configuration, data-directory/SQLite writability and exact schema identity, the strict agent catalog, locally admitted agent executables, the standalone runner, configured provider health, default-provider registration, the local-static target, and optionally a configured control plane's readiness. It does not resolve a remote runtime's executables on the control-plane host. Cloudflare bridge health is included when that provider is configured. It is diagnostic, not a substitute for the provider image checks and live proof.

## Telemetry

Meanwhile emits three distinct evidence products:

1. durable owner-visible run logs plus run/session event journals;
2. operational JSON logs, manual OpenTelemetry spans, metrics, and diagnostics;
3. append-only audit records.

Never route all three through one logging sink and call that observability.

Operational log records use a stable event name, level, timestamp, and applicable request/trace/owner/run/session/turn/runtime/process/deployment/provider identifiers. Prompts, process output, repository credentials, file contents, resolved secrets, raw provider bodies, and signed URLs are forbidden fields. Process and workspace output is redacted and persisted only as owner-visible product evidence; operational records carry byte counts, stream identity, cursors, and stable codes instead.

Meanwhile passes trace parentage explicitly between operation scopes because it does not depend on Node async-context propagation under Bun. The restricted span facade enforces the attribute allowlist and outcome semantics; it never exposes a raw OpenTelemetry span. Observable run/session queues, active-run/session/runtime state, both cleanup backlogs, and deployment gauges are read from durable SQLite state, so a control-plane restart cannot produce negative in-memory deltas.

Metric labels are bounded: provider, agent, operation, status, and stable error code are reasonable; owner, run, session, turn, and process IDs, URLs, messages, and prompts are not.

OTLP export is optional and must remain disabled until the pinned OTel base SDK and exporter pass `test/contracts/telemetry.test.ts` under Bun. An exporter outage is visible locally and in health diagnostics but cannot block state transactions or change a run result.

## Database schema

Meanwhile owns one current schema. An empty database is initialized statement-by-statement in one transaction and receives the exact source fingerprint only after every statement succeeds. A nonempty database must already contain that exact identity or startup fails without modifying it. The initializer deliberately avoids Bun's multi-statement `Database.exec()` path because it does not reliably surface every statement-level failure.

Rules:

- edit the current schema directly and treat a fingerprint change as a fresh-data-root boundary;
- make constraints and indexes explicit;
- preserve owner scoping and append-only evidence;
- never add database upgrade, backfill, repair, or dual-read code;
- test fresh initialization, atomic failure, fingerprint drift, and rejection of every foreign or partial database;
- record the fresh-root requirement in `CHANGELOG.md`.

A changed schema requires a new empty data root. Durable product data may move only through an explicit, separately designed export/import boundary; the service never guesses how database rows should be rewritten.

## Backup and restore

A valid backup contains SQLite, every referenced workspace/artifact object, exactly the local-static preview bytes referenced by successful deployment rows, the exact schema identity, service/Bun versions, and per-file hashes from one quiescent point.

Stop the service, then use the maintenance boundary:

```console
bun run cli -- data backup --output /backups/meanwhile-2026-07-14
bun run cli -- data verify /backups/meanwhile-2026-07-14
```

The adjacent data-root lease rejects the command if a control plane or another maintenance process is active. Backup also rejects queued/provisioning/running runs, operational agent sessions, or in-progress deployment/cleanup work. It serializes SQLite into a standalone non-WAL snapshot, walks the referenced immutable object graph, derives preview reachability from that snapshot, and verifies each publication against its immutable artifact before copying. Missing, extra, linked, orphan, or digest-mismatched preview files fail the operation. Physical paths are canonicalized, so the output must be outside the live root even through symlink aliases.

Restore only into an absent or empty configured data root:

```console
MEANWHILE_DATA_DIR=/srv/meanwhile-restored \
  bun run cli -- data restore /backups/meanwhile-2026-07-14
```

Restore verifies before writing, stages the complete root, creates an empty disposable-runtime directory, reopens the database read-only, and publishes by rename. Then run `doctor`, start the service, confirm schema identity and cleanup state, and exercise owner-scoped artifact/audit reads before admitting traffic.

Ordinary copying of a live SQLite file is unsupported because it can omit WAL state and immutable bytes. Test restoration periodically; an unverified archive is not a backup strategy.

Garbage collection uses the same exclusive, quiescent maintenance boundary:

```console
bun run cli -- data gc --dry-run
bun run cli -- data gc --apply
```

It derives reachability from durable workspace/artifact references and successful local-static deployments. It may remove only unreferenced content-addressed objects, interrupted temporary objects, and unreferenced preview trees. It never deletes relational history or referenced bytes.

## Runtime cleanup

Cleanup is durable work with pending/running/succeeded/failed state, attempt count, last safe error, and next eligible time.

Monitor:

- cleanup backlog and oldest eligible age;
- attempts and explicit bounded backoff;
- destroy latency and failure count by provider/error code;
- active runtimes versus active runs and agent sessions;
- terminal runs or closed sessions that still own an uncleared runtime.

Never manually delete database runtime rows to silence the backlog. Diagnose provider reachability and handle validity, destroy the resource through the adapter, and preserve audit evidence. Cleanup never targets an authoritative `running` run or operational agent session.

## Cloudflare bridge operations

The bridge is a separate deployment boundary running in Cloudflare `workerd` and Sandbox containers. Its provider SDK, custom container image, standalone Bun runner, and live-agent toolchains are pinned as one compatibility unit. The reference image runs as `standard-1`: `lite` is useful for deterministic bridge checks but its 256 MiB memory limit is below the observed coding-agent process set. A production deployment may derive smaller agent-profile images while preserving the same adapter and provenance contract.

The pinned SDK has no ongoing process-stdin primitive. Durable sessions therefore use a bridge-owned sequential mailbox: Durable Object state binds each `(process, sequence)` to one command fingerprint before sandbox publication. Treat mailbox support as a versioned provider capability, not generic shell input or remote ACP.

Target workflow:

```console
bun run cloudflare:check
bun run cloudflare:dev
bun run cloudflare:deploy
bun run test:live:cloudflare
```

Before enabling it in the control plane:

1. configure a high-entropy `BRIDGE_TOKEN` secret binding in the Cloudflare deployment;
2. deploy the exact bridge and container image revision tested together;
3. set `CLOUDFLARE_BRIDGE_URL` to that deployment's URL and set control-plane `CLOUDFLARE_BRIDGE_TOKEN` to the same secret value stored under bridge binding `BRIDGE_TOKEN`;
4. after a deploy, poll Cloudflare's container-application state until all declared instances are healthy and none are starting, scheduling, or failed; then poll the authenticated `/v1/health` boundary until the expected bridge protocol is stable. A successful Wrangler mutation is neither container-rollout nor edge readiness, and a fixed sleep is not evidence. Do not admit a runtime while the application is still provisioning because the rollout may replace an already observed physical generation;
5. record `CLOUDFLARE_RUNNER_DIGEST` plus the matching `CLOUDFLARE_RUNTIME_IMAGE_REFERENCE` and `CLOUDFLARE_RUNTIME_IMAGE_DIGEST`; absent evidence remains `null` rather than being guessed;
6. run `doctor` and the mock-bridge integration tests;
7. run `bun run test:live:cloudflare` with the deployed bridge URL and token; the deterministic suite never auto-enables it from ambient credentials;
8. run `bun run proof:release:cloudflare` to prove the deterministic ACP/provider compatibility path with complete configured provenance;
9. run `bun run proof:release:cloudflare:codex`, `bun run proof:release:cloudflare:claude`, and `bun run proof:release:cloudflare:pi` to require credentialed generation, explicit Brief-backed follow-up output, two-turn continuity across control-plane restart, SDK artifact download, SDK `local-static` deployment, URL verification, OTLP telemetry, cleanup and credential revocation for both one-shot runs and the session, backup/restore, and second boot for every bundled toolchain;
10. verify each generated receipt with `bun run proof:verify -- <receipt> --require-clean --commit=<sha>`; an installed toolchain or configured command is not execution evidence;
11. for release evidence, run the explicit `Remote proof` GitHub workflow on the release revision. Configure bridge URL, runner/image provenance, and region as repository variables; configure the bridge token and relevant agent credential as repository secrets. The workflow repeats the real provider lifecycle, rejects dirty or mismatched evidence, retains the receipt, and signs its artifact provenance;
12. inspect Cloudflare for leaked test resources.

Every release-proof command rebuilds both standalone runtime executables before admission. A proof therefore never depends on an untracked `dist/` left by another command.

Each agent command is an independent gate. Failure produces no receipt and cannot be inferred away from another agent's result. The exact pinned `pi-acp@0.0.31` currently maps an internal Pi prompt error to ACP `end_turn`; the release proof still fails on the empty semantic response and missing artifact, so Pi is not a proven live-agent path until that adapter propagates failure correctly and a clean current-revision receipt passes.

The live provider test also proves the native security path: source credential absent from process environment, exact allowed-host substitution, durable revocation, and default-deny egress after revocation. Live-agent proofs accept only credential shapes that remain opaque to the client. Codex therefore requires an API key; ChatGPT session tokens, Claude file credentials, and metadata-service authority are rejected instead of being injected into the sandbox. A successful live-agent receipt proves the configured agent path and generated artifact; it records exact downstream model identity as `not-attested`.

Wrangler upload completion is not bridge readiness. Deployment automation owns container-application rollout convergence; the live test and release proofs then use the same authenticated Bun `RuntimeProvider.health()` transport as production and wait within a fixed budget before beginning lifecycle assertions. Health proves bridge protocol availability, not compute materialization. The Cloudflare adapter retries a provider-classified transient first Sandbox start with bounded backoff under the run's provisioning deadline, but it correctly fails closed with `RUNTIME_LOST` if the platform replaces a physical generation after acceptance. A different client or an arbitrary delay is not accepted as readiness evidence.

The configured runner digest and matching custom-image reference/digest are operator/platform assertions used to pin execution identity. A base-image tag is never paired with a custom-image digest. These values are not presented as cryptographic runtime attestation; unavailable platform evidence stays `null` in ordinary runs.

Do not confuse a sleeping container with a destroyed sandbox. Do not place Cloudflare account credentials in the agent runtime. Rotate the bridge token as a control-plane credential and ensure old revisions fail closed on protocol mismatch.

## Local static previews

The preview server publishes only immutable artifact content and binds to a separate origin/port from the authenticated API. It uses unguessable deployment identities and defensive headers. When the listener binds `0.0.0.0` or `::`, `MEANWHILE_PREVIEW_PUBLIC_URL` is mandatory and is the browser-facing origin persisted in deployment URLs; wildcard bind addresses are never published.

Operational rules:

- never route preview paths through authenticated API cookies or bearer handling;
- do not enable directory traversal, symlink following, CGI, or server-side execution;
- set a conservative content type and `X-Content-Type-Options: nosniff`;
- apply an explicit CSP appropriate for the preview contract;
- avoid shared mutable cache keys across owners;
- remove derived preview material without deleting the artifact source.

Treat all uploaded HTML, JavaScript, SVG, and media as hostile.

## Failure playbooks

### Run remains `provisioning`

1. Correlate run ID to the provisioning span and provider operation.
2. Compare the persisted UTC deadline with control-plane time and inspect the runner's accepted relative budget; do not compare it with sandbox wall time.
3. Inspect the runtime handle through the adapter, not the provider console alone.
4. Check whether runner process identity was persisted before the failure.
5. Let the executor claim timeout or structured provider failure; do not edit status manually.
6. Confirm the runtime becomes cleanup-eligible.

### `RUNTIME_LOST`

1. Confirm the provider reports missing or cannot recover the persisted handle.
2. Inspect event replay and last accepted runner sequence for final evidence.
3. Check provider retention/idle policies and bridge protocol compatibility.
4. Preserve the terminal error and audit trail.
5. Search for an orphan by provider-native identity and destroy it through a controlled operator path if found.

### Cleanup backlog grows

1. Check provider health, quota, auth, and destroy error codes.
2. Verify failed entries have bounded next-attempt times rather than tight loops.
3. Ensure no `running` run was claimed.
4. Reconcile provider-native resources against persisted opaque handles.
5. Rotate credentials or repair the adapter, then allow durable retries to continue.

### SQLite busy or storage full

1. Verify there is only one active writer.
2. Inspect disk bytes and inodes for database, WAL, artifacts, and local runtime directories.
3. Stop admission before storage exhaustion corrupts higher-level operations.
4. Do not delete WAL, database, artifact objects, or audit rows by hand.
5. Expand durable storage or restore into a verified empty location.

### Suspected secret exposure

1. Stop affected runs and disable the exposed credential immediately.
2. Preserve restricted audit and operational evidence without redistributing the value.
3. Search all three output planes and artifact storage using secure operator tooling.
4. Quarantine affected artifacts and deployments.
5. Rotate credentials and bridge/API keys.
6. Identify the first boundary that observed output without an initialized redactor.
7. Follow [SECURITY.md](../SECURITY.md); do not publish exploit details before remediation.

### Telemetry exporter unavailable

1. Confirm local JSON logs continue and run state progresses.
2. Inspect the exporter health component and stable error code.
3. Verify endpoint, TLS, auth headers supplied by the platform, and network policy without printing them.
4. Restore export; do not restart or cancel agent runs solely to repair telemetry.

## Production readiness checklist

- [ ] Exact release revision and schema fingerprint are recorded.
- [ ] Full deterministic test suite passes under the supported Bun version.
- [ ] `doctor` passes with production configuration.
- [ ] API keys are provisioned through the persistent hashed-key lifecycle; bootstrap key is disabled.
- [ ] Data root has durable capacity, restrictive ownership, backup, and tested restore.
- [ ] The data-root lease and deployment topology enforce exactly one active SQLite writer.
- [ ] Runner binary provenance and execute permissions are verified.
- [ ] Every configured ACP agent is pinned and catalog-validated.
- [ ] Local provider is disabled for untrusted tenants.
- [ ] Remote provider shared contract and live lifecycle tests pass.
- [ ] Any provider admitting durable sessions has evidence for ordered input, replay, reconnect, interrupt, close, and cleanup on the exact bridge/image revision; deterministic contract evidence and live-provider evidence are listed separately rather than merged.
- [ ] The release receipt verifies as clean and matches the exact revision, including Brief-backed follow-up evidence, telemetry export, and backup restore; remote release requires complete configured runner/image provenance and retained signed artifact provenance.
- [ ] Bridge credentials are scoped, stored outside images, and rotatable.
- [ ] Both cleanup backlogs, run/session queue latency, run/turn outcomes, continuity loss, and storage capacity are monitored.
- [ ] OTLP compatibility is proven under Bun before export is enabled.
- [ ] Preview origin, headers, routing, and public exposure are reviewed.
- [ ] Threat model and security reporting route are current.
- [ ] Upgrade and rollback procedures are rehearsed on a copy of production data.

No interface, mock, green unit test, or provider health response alone establishes production readiness. The complete local flow and a real remote lifecycle must both be proven.
