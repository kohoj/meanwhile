# Operations

This document defines the implemented operating contract for Meanwhile's single-control-plane topology. The repository is pre-release; run the referenced checks on the exact revision before operating it. [AGENTS.md](../AGENTS.md) remains the source of architectural invariants.

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
| `MEANWHILE_LOCAL_PROVIDER` | No | `auto`, `enabled`, or `disabled`; `auto` admits new local runs only for a loopback API host while the internal adapter remains available for cleanup/reconciliation |
| `MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER` | Only for explicit non-loopback local execution | Acknowledges that authenticated tenants can execute as the control-plane OS user |
| `MEANWHILE_SECRET_ENV_ALLOWLIST` | For local-bootstrap `env://` sources | Comma-separated validated names available only to the bootstrap owner; source and target must match, reserved names are forbidden, and empty denies all |
| `MEANWHILE_OTEL_ENABLED` | No | Explicitly enables the tested OTel SDK/export path |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | When OTel enabled | OTLP/HTTP collector endpoint; no credentials in the URL |
| `CLOUDFLARE_BRIDGE_URL` | For Cloudflare | Deployed bridge base URL |
| `CLOUDFLARE_BRIDGE_TOKEN` | For Cloudflare | High-entropy bridge credential |

The complete safe template is [.env.example](../.env.example). Invalid recognized values, ports, catalog entries, default-provider selection, and endpoints fail validation rather than falling back silently. An explicit unknown provider on run creation is rejected before input or run persistence.

Any variable referenced through `env://NAME` is a process secret, not ordinary configuration. It must not be emitted by `doctor`, health, logs, telemetry, audit, or error output. The environment catalog is deliberately single-owner; provisioned tenants need a tenant-scoped secret-manager adapter. Checkout credentials additionally require repository-host binding and are therefore unsupported by this environment source.

## Durable data

`MEANWHILE_DATA_DIR` is one backup and ownership unit. The implementation derives internal database, artifact, preview, and local-runtime paths beneath it; operators should not configure competing locations.

Properties:

- SQLite contains relational state and artifact references, never artifact bodies or resolved secret values.
- Artifact objects are immutable and content-addressed.
- Runtime working directories are disposable even when located beneath the data root.
- Audit, run logs, status history, deployments, and cleanup state survive service restart.
- Preview output is derived from immutable artifacts; it is not a second source of truth.

Set restrictive filesystem ownership for the service account. The control plane needs read/write access to the data root and execute access to the runner. Other users should have no access. Do not place the data root inside a repository workspace.

## Startup

The startup order is:

1. validate environment configuration and initialize telemetry before application composition;
2. create the data root, open SQLite, and apply transactional migrations;
3. bootstrap the optional local identity and validate the agent catalog;
4. compose provider, artifact, and deployment registries and require the configured default provider to exist;
5. start reconciliation, execution, deployment, and cleanup supervisors;
6. bind the Bun HTTP server and expose readiness.

Invalid configuration, migration/schema state, catalog data, registry collisions, or an unknown default provider fail startup. The preview listener starts lazily on the first local-static deployment. Runner availability is always an explicit `doctor` check. Catalog agent executables are host-checked only when the local provider admits new runs; remote toolchains are an image and live-provider proof concern. A missing executable never masquerades as startup health and causes the affected run to fail with durable evidence.

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

Mount `MEANWHILE_DATA_DIR` on durable storage and ensure the container's service user owns it. The supplied Compose topology publishes API and preview ports on host loopback only. It deliberately sets `MEANWHILE_LOCAL_PROVIDER=enabled` and `MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER=true` because container-internal listeners bind all interfaces; it is for trusted local work and must not be exposed to untrusted tenants.

`compose.yaml` optionally reads `${MEANWHILE_ENV_FILE:-./compose.env}`. Copy [compose.env.example](../compose.env.example) for Cloudflare bridge settings or local-bootstrap agent secret values named by `MEANWHILE_SECRET_ENV_ALLOWLIST`. The file is ignored by Git and Docker build context. It is not required by shell-only Bun workflows, and production should use an owner-scoped secret broker rather than a plaintext process environment.

## Shutdown and restart

On a normal shutdown the Bun HTTP server stops first, then the control-plane supervisors stop, the separate preview listener closes, telemetry flushes and shuts down while its durable gauges can still read SQLite, and SQLite closes last. Each supervisor owns the safe termination or handoff of work it has already claimed; shutdown does not reinterpret an unfinished run as an agent failure.

Do not cancel active remote agents merely because the API process is restarting. Persisted runtime/process handles and cursors allow startup reconciliation when the provider supports it. Local child processes need explicit supervisor semantics and must not be assumed recoverable merely because a PID was stored.

After an unclean restart:

- queued runs remain eligible;
- terminal runs remain immutable;
- provisioning/running runs are inspected and replayed from persisted cursors;
- active sessions reconnect where supported;
- exited sessions finalize from accepted runner evidence and process facts;
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

`doctor` validates environment configuration, data-directory/SQLite writability and migrations, the strict agent catalog, locally admitted agent executables, the standalone runner, configured provider health, default-provider registration, the local-static target, and optionally a configured control plane's readiness. It does not resolve a remote runtime's executables on the control-plane host. Cloudflare bridge health is included when that provider is configured. It is diagnostic, not a substitute for the provider image checks and live proof.

## Telemetry

Meanwhile emits three distinct evidence products:

1. durable owner-visible run logs;
2. operational JSON logs, manual OpenTelemetry spans, metrics, and diagnostics;
3. append-only audit records.

Never route all three through one logging sink and call that observability.

Operational log records use a stable event name, level, timestamp, and applicable request/trace/owner/run/runtime/process/deployment/provider identifiers. Prompts, process output, repository credentials, file contents, resolved secrets, raw provider bodies, and signed URLs are forbidden fields. Process and workspace output is redacted and persisted only as owner-visible sequenced run logs; operational records carry byte counts, stream identity, cursors, and stable codes instead.

Meanwhile passes trace parentage explicitly between operation scopes because it does not depend on Node async-context propagation under Bun. The restricted span facade enforces the attribute allowlist and outcome semantics; it never exposes a raw OpenTelemetry span. Observable queue, active-run/runtime, cleanup-backlog, and deployment gauges are read from durable SQLite state, so a control-plane restart cannot produce negative in-memory deltas.

Metric labels are bounded: provider, agent, operation, status, and stable error code are reasonable; owner IDs, run IDs, URLs, messages, and prompts are not.

OTLP export is optional and must remain disabled until the pinned OTel base SDK and exporter pass `test/contracts/telemetry.test.ts` under Bun. An exporter outage is visible locally and in health diagnostics but cannot block state transactions or change a run result.

## Database migrations

Migrations are ordered, immutable after release, and applied in a transaction before readiness. A migration records its identity only after the schema change commits.

Rules:

- never edit an already released migration;
- make constraints and indexes explicit;
- preserve owner scoping and append-only evidence;
- backfill deterministically before enforcing a new constraint;
- do not hide state transitions in migration-side application code;
- test a fresh database and an upgrade from every supported release fixture;
- record compatibility impact in `CHANGELOG.md`.

A failed migration halts startup. Operators restore from backup or deploy a corrected forward migration; the service must not guess.

## Backup and restore

A valid backup contains both SQLite state and artifact bytes from one consistent operational point.

Before the first release, the conservative supported procedure is:

1. stop the single control-plane writer cleanly;
2. verify no service process still has the database open;
3. make an atomic filesystem snapshot or archive of the entire data root;
4. record the application revision and schema migration level with the backup;
5. restart and verify readiness.

An online database-only copy is insufficient because it can omit WAL state or artifact bytes. A production online-backup feature must coordinate SQLite's backup API with an artifact manifest; do not document ordinary `cp` of a live database as safe.

Restore into an empty data root with the same or newer compatible release, restrictive ownership, and no active writer. Run `doctor`, start the service, confirm migrations, inspect cleanup backlog, and exercise an owner-scoped read before admitting traffic.

Test restoration periodically. An untested archive is not a backup strategy.

## Runtime cleanup

Cleanup is durable work with pending/running/succeeded/failed state, attempt count, last safe error, and next eligible time.

Monitor:

- cleanup backlog and oldest eligible age;
- attempts and explicit bounded backoff;
- destroy latency and failure count by provider/error code;
- active runtimes versus active runs;
- terminal runs that still own an uncleared runtime.

Never manually delete database runtime rows to silence the backlog. Diagnose provider reachability and handle validity, destroy the resource through the adapter, and preserve audit evidence. Cleanup never targets an authoritative `running` run.

## Cloudflare bridge operations

The bridge is a separate deployment boundary running in Cloudflare `workerd` and Sandbox containers. Its provider SDK and container image versions are pinned as one compatibility pair.

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
4. run `doctor` and the mock-bridge integration tests;
5. run `bun run test:live:cloudflare` with the deployed bridge URL and token; the deterministic suite never auto-enables it from ambient credentials;
6. verify create, start, process events, file read/write, stop, and explicit destroy;
7. inspect Cloudflare for leaked test resources.

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
2. Compare the persisted deadline with the injected clock and current time.
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

- [ ] Exact release revision and migration level are recorded.
- [ ] Full deterministic test suite passes under the supported Bun version.
- [ ] `doctor` passes with production configuration.
- [ ] API keys are provisioned through the persistent hashed-key lifecycle; bootstrap key is disabled.
- [ ] Data root has durable capacity, restrictive ownership, backup, and tested restore.
- [ ] Exactly one active SQLite writer is enforced by deployment topology.
- [ ] Runner binary provenance and execute permissions are verified.
- [ ] Every configured ACP agent is pinned and catalog-validated.
- [ ] Local provider is disabled for untrusted tenants.
- [ ] Remote provider shared contract and live lifecycle tests pass.
- [ ] Bridge credentials are scoped, stored outside images, and rotatable.
- [ ] Cleanup backlog, queue latency, run outcomes, and storage capacity are monitored.
- [ ] OTLP compatibility is proven under Bun before export is enabled.
- [ ] Preview origin, headers, routing, and public exposure are reviewed.
- [ ] Threat model and security reporting route are current.
- [ ] Upgrade and rollback procedures are rehearsed on a copy of production data.

No interface, mock, green unit test, or provider health response alone establishes production readiness. The complete local flow and a real remote lifecycle must both be proven.
