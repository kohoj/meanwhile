# Meanwhile

**Durable infrastructure for agent work.**

[![CI](https://github.com/kohoj/meanwhile/actions/workflows/ci.yml/badge.svg)](https://github.com/kohoj/meanwhile/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun_1.3.13-black)](https://bun.sh/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> Agents and machines are replaceable. The run is not.

Meanwhile gives agent work a portable identity. One `RunSpec` composes intent, an [ACP](https://agentclientprotocol.com/) agent, a runtime, and policy; the resulting state, evidence, artifacts, cleanup, and deployments survive the machine that executed it.

Run a fix, migration, review, or release on disposable compute. Hand the resulting run—not a terminal session—to the next person or agent. Promote only immutable output.

```text
fix one repo · maintain a fleet · compare agents · ship generated software
                              │
                        SDK · API · CLI
                              │ RunSpec
        ┌─────────────────────▼─────────────────────┐
        │                 MEANWHILE                 │
        │ intent → durable run → evidence → artifact│
        │ auth · policy · audit · recovery · cleanup│
        └──────────────┬────────────────┬───────────┘
                       │                └── DeployAdapter → URL
                RuntimeProvider
                       │ disposable compute
      local · Cloudflare · Daytona · Fly · Modal · your adapter
                       │ meanwhile-runner
                       │ local ACP
       Claude Code · Codex · Hermes · OMP · any ACP agent
```

## The run is the product

An agent process is a tool. A sandbox is a temporary place to run it. Neither is the durable product boundary.

Meanwhile makes the run that boundary: something an application can route, observe, cancel, recover, audit, and promote without learning the agent harness or infrastructure API underneath it.

Meanwhile keeps four lifecycles separate:

| Entity | Lifetime | Authority |
| --- | --- | --- |
| **Run** | Durable | User intent and authoritative status |
| **Runtime** | Disposable | Provider compute and process facts |
| **Artifact** | Durable, immutable | Content-addressed output bytes |
| **Deployment** | Durable | Auditable promotion of an artifact |

A runtime may disappear without erasing its run. A deployment never reaches back into a mutable workspace. Provider logs report facts; they never decide run state.

## Run it locally

Requires [Bun 1.3.13+](https://bun.sh/) and Git. Every Meanwhile application, CLI, demo, proof, and runtime-local runner process executes with Bun. Cloudflare's bridge executes in `workerd`, while its official deployment tooling may carry its own host runtime; neither introduces Node into the product runtime. The local provider needs no cloud account, but it is **not a security sandbox**.

```console
bun install
cp .env.example .env
bun -e 'import { issueApiKey } from "./src/auth.ts"; console.log("MEANWHILE_API_KEY=" + (await issueApiKey()).key)' >> .env
bun run runtime:build
bun run doctor
bun run dev
```

The API starts at `http://127.0.0.1:7331`; local previews use the separate origin `http://127.0.0.1:7332`. Startup applies transactional SQLite migrations before readiness. OpenAPI is available at `/openapi.json`.

To exercise the complete no-account path in one command:

```console
bun run demo
```

That command creates a run, follows logs, captures an artifact, deploys it through `local-static`, and fetches the preview.

## One run, end to end

The typed client is the canonical programmatic interface. It uses Web `fetch`, `AbortSignal`, streams, and the same Zod contracts as the HTTP API. Install the tagged source package from a Bun client project:

```console
bun add github:kohoj/meanwhile#v0.1.1
```

The example below assumes the Codex ACP entry described under [Agent execution](#agent-execution) is installed in the selected runtime.

```ts
import { Meanwhile } from "meanwhile"
import { captureWorkspace } from "meanwhile/workspace"

const meanwhile = new Meanwhile({
  baseUrl: process.env.MEANWHILE_URL ?? "http://127.0.0.1:7331",
  apiKey: process.env.MEANWHILE_API_KEY!,
})

const run = await meanwhile.runs.create(
  {
    workspace: { type: "files", files: await captureWorkspace("./workspace") },
    agentType: "codex",
    provider: "local",
    prompt: "Build and verify the requested change.",
    artifactPaths: ["dist"],
    timeoutMs: 15 * 60_000,
  },
  { idempotencyKey: crypto.randomUUID() },
)

for await (const log of meanwhile.runs.followLogs(run.id)) {
  console.log(log.sequence, log.eventType, log.data)
}

const finished = await meanwhile.runs.wait(run.id)
if (finished.status !== "succeeded") throw new Error(`run ${finished.status}`)

const artifact = (await meanwhile.artifacts.list(finished.id)).find(
  ({ logicalPath }) => logicalPath === "dist",
)
if (!artifact) throw new Error("dist artifact was not captured")

const download = await meanwhile.artifacts.download(artifact.id, {
  path: "index.html",
})
const bytes = new Uint8Array(await new Response(download.body).arrayBuffer())
const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
if (digest !== download.digest) throw new Error("artifact digest mismatch")

const deployment = await meanwhile.deployments.create({
  runId: finished.id,
  artifactPath: "dist",
  deployTarget: "local-static",
})

console.log((await meanwhile.deployments.wait(deployment.id)).url)
```

Repository input is equally direct:

```json
{
  "workspace": {
    "type": "repository",
    "url": "https://github.com/example/project.git",
    "revision": "main"
  },
  "agentType": "codex",
  "prompt": "Fix the failing tests.",
  "provider": "cloudflare",
  "env": {},
  "secretRefs": { "OPENAI_API_KEY": "env://OPENAI_API_KEY" },
  "artifactPaths": ["dist"],
  "timeoutMs": 900000
}
```

Identity never comes from this body. Every protected request derives the owner from its bearer API key.

The CLI is a presentation layer over the same client:

```console
bun run cli -- run --agent codex --provider local --files ./workspace --artifact dist -- <task>
bun run cli -- logs <run-id> --follow
bun run cli -- cancel <run-id>
bun run cli -- deploy <run-id> --artifact dist --target local-static
```

## API

The SDK call above is this portable HTTP operation:

```console
curl --fail-with-body \
  -X POST http://127.0.0.1:7331/runs \
  -H "Authorization: Bearer $MEANWHILE_API_KEY" \
  -H 'Idempotency-Key: readme-quickstart-1' \
  -H 'Content-Type: application/json' \
  --data '{
    "workspace":{"type":"repository","url":"https://github.com/example/project.git","revision":"main"},
    "agentType":"codex","provider":"local","prompt":"Fix and verify the failing tests.",
    "env":{},"secretRefs":{},"artifactPaths":["dist"],"timeoutMs":900000
  }'
```

All failures use one safe envelope:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe human-readable message",
    "requestId": "req_...",
    "details": {}
  }
}
```

| Resource | Routes |
| --- | --- |
| Runs | `POST /runs`, `GET /runs`, `GET /runs/:id`, `POST /runs/:id/cancel` |
| Evidence | `GET /runs/:id/logs`, `GET /runs/:id/artifacts` |
| Artifacts | `GET /artifacts/:id`, `GET /artifacts/:id/content` |
| Deployments | `POST /deployments`, `GET /deployments`, `GET /deployments/:id`, `GET /deployments/:id/logs` |
| Providers | `POST /providers/test` |
| Operations | `GET /audit`, API-key lifecycle, `/healthz`, `/readyz`, `/openapi.json` |

Run logs support cursor pagination and SSE follow over the same durable sequence. `runs.followLogs()` resumes with `Last-Event-ID`, deduplicates replay, rejects gaps, and honors caller cancellation.

## Agent execution

Meanwhile is harness-neutral because the runtime-local `meanwhile-runner` speaks ACP over stdio. ACP initialization, capability negotiation, session creation, prompting, permission decisions, cancellation, and shutdown stay beside the agent; provider APIs transport process lifecycle and replayable frames rather than pretending to be a remote terminal.

`config/agents.json` is the only active launch catalog. Each entry declares a bare PATH executable, argv, working-directory policy, capabilities, and allowed environment names. The accepted definition and its digest are snapshotted into the run, so a queued or recovering run cannot silently change when the catalog changes.

The checkout ships a deterministic `demo` agent. Copy the required entries from [docs/agents.example.json](docs/agents.example.json) after installing the corresponding ACP adapters in the runtime image:

```json
{
  "version": 1,
  "agents": {
    "codex": {
      "transport": "stdio",
      "executable": "codex-acp",
      "args": [],
      "workingDirectory": "workspace",
      "capabilities": { "filesystem": true, "terminal": true },
      "envNames": ["CI"],
      "secretEnvNames": ["OPENAI_API_KEY"]
    }
  }
}
```

Claude Code, Pi, and Hermes use the same shape with `claude-agent-acp`, `pi-acp`, and `hermes-acp`. A tool without native ACP needs a small explicit adapter executable; agent-specific output parsing never belongs in the control plane.

Authenticated local proofs are available when the corresponding local credentials are configured:

```console
bun run demo:codex
bun run demo:claude
bun run demo:pi
```

Each command installs an exact adapter/runtime pair into a disposable directory, references existing local authentication only for the agent process, sends a real ACP task, verifies the agent-written artifact, deploys it through the API, and fetches the immutable preview. The Pi proof uses its pinned headless RPC runtime through `pi-acp`; on this bootstrap path it accepts an allowlisted Amazon Bedrock token and region without persisting either value.

## Runtime providers

A provider owns isolated compute, process identity and replay, workspace files, optional port exposure, and health. It never sees public owner policy, run-state transitions, artifact retention, deployments, or SQL.

The stable contract is intentionally deeper than `runCommand(string)`:

```ts
interface RuntimeProvider {
  create(input: CreateRuntimeInput): Promise<RuntimeHandle>
  start(runtime: RuntimeHandle): Promise<void>
  inspect(runtime: RuntimeHandle): Promise<RuntimeState>
  stop(runtime: RuntimeHandle): Promise<void>
  destroy(runtime: RuntimeHandle): Promise<void>

  spawn(runtime: RuntimeHandle, process: ProcessSpec): Promise<ProcessHandle>
  inspectProcess(process: ProcessHandle): Promise<ProcessState>
  events(process: ProcessHandle, cursor: EventCursor, signal?: AbortSignal): AsyncIterable<ProcessEvent>
  signal(process: ProcessHandle, signal: ProcessSignal): Promise<void>
  wait(process: ProcessHandle): Promise<ProcessExit>

  writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void>
  listFiles(runtime: RuntimeHandle, path: RelativePath, options: ListRuntimeFilesOptions): Promise<RuntimeFileInfo[]>
  readFile(runtime: RuntimeHandle, path: RelativePath, options: ReadRuntimeFileOptions): Promise<Uint8Array>
  expose?(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint>
  health(): Promise<ProviderHealth>
}
```

`local` is the deterministic reference implementation. `cloudflare` is a real provider backed by the official Cloudflare Sandbox SDK through an independently deployable, authenticated bridge. The SDK, image, standalone Bun runner, and bundled Claude ACP adapter are pinned as one compatibility unit; Cloudflare types remain inside the provider package. Retryable event reads resume from the same durable cursor, so a transient bridge failure cannot silently duplicate or skip accepted evidence.

The shipped Cloudflare image uses `standard-1` deliberately: a real Claude coding-agent process exceeded the `lite` class's 256 MiB limit. Deterministic bridge checks can fit smaller compute, but the supported live-agent proof must use a class sized for the agent toolchain. Runtime destruction remains the cost boundary.

Configure the deployed bridge in the control plane:

```dotenv
MEANWHILE_DEFAULT_PROVIDER=cloudflare
CLOUDFLARE_BRIDGE_URL=https://<bridge-worker>
CLOUDFLARE_BRIDGE_TOKEN=<high-entropy shared credential>
CLOUDFLARE_RUNNER_DIGEST=<sha256 of deployed meanwhile-runner>
CLOUDFLARE_RUNTIME_IMAGE_REFERENCE=<deployed custom image reference>
CLOUDFLARE_RUNTIME_IMAGE_DIGEST=sha256:<deployed image digest>
```

Then verify it explicitly—remote mutation is never triggered merely because credentials exist:

```console
bun run cloudflare:check
bun run test:live:cloudflare
bun run proof:release:cloudflare          # deterministic ACP compatibility proof
bun run proof:release:cloudflare:claude   # real Claude generation → SDK download → deploy → URL
```

To add Daytona, Fly Machines, Modal, or another backend, implement `RuntimeProvider`, declare truthful capabilities, and pass the shared provider contract plus a real-account lifecycle proof. The run executor contains no provider-name branches. See [Provider contract](docs/provider-contract.md).

## One-click deployment

`POST /deployments` resolves exactly one `artifactPath` or logical `workspacePath` to immutable stored bytes before invoking a target adapter. It never reads an arbitrary host path or a runtime that may already have been destroyed.

```console
curl --fail-with-body \
  -X POST http://127.0.0.1:7331/deployments \
  -H "Authorization: Bearer $MEANWHILE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{
    "runId": "<run-id>",
    "artifactPath": "dist",
    "deployTarget": "local-static",
    "config": {},
    "secretRefs": {}
  }'
```

The response is a durable deployment record. The executor stores ordered logs, structured failures, audit evidence, and the validated preview or deployment URL. `local-static` completes the entire flow without a cloud account and serves untrusted output on an origin separate from the authenticated API.

New targets implement `DeployAdapter` over an immutable source; they do not receive a Store, RuntimeProvider, or owner identity.

## Data model and correctness

SQLite in WAL mode is the source of truth for one active control-plane writer. It stores relational metadata and references; immutable workspace and artifact bytes live in an owner-scoped content-addressed store under `MEANWHILE_DATA_DIR`.

```text
Owner ── API keys
  └── Run ── status events ── sequenced logs
       ├── runtime instance ── runner cursor ── cleanup state
       ├── immutable input bundle
       └── immutable artifacts ── deployments ── deployment logs
All mutations ── append-only audit records
```

Public run states are exactly:

```text
queued → provisioning → running → succeeded
  │           │             ├──→ failed
  │           │             ├──→ cancelled
  │           │             └──→ timed_out
  │           └────────────────→ failed | cancelled | timed_out
  └────────────────────────────→ cancelled
```

`running` means ACP initialization and session creation succeeded—not merely that a process exists. Terminal states are immutable. Runtime cleanup has its own lifecycle and never deletes run history.

| Guarantee | Implementation |
| --- | --- |
| Tenant isolation | Bearer keys derive identity; all public reads and mutations include `ownerId`; cross-owner access returns `NOT_FOUND` |
| Secrets | Public input stores references only; values resolve immediately before use, are redacted before output consumption, and never enter SQLite or artifacts |
| Idempotency | `(ownerId, Idempotency-Key)` and a canonical request hash commit with the run; conflicting reuse returns `409` |
| Timeout | Provisioning starts a persisted absolute deadline; the runner receives only a remaining monotonic duration |
| Cancellation | Intent commits before signalling; one compare-and-swap transition claims `cancelled`; cleanup follows separately |
| Restart recovery | Persisted runtime/process handles and cursors reconnect and deduplicate replay where provider capabilities permit |
| Cleanup | Terminal runtimes enter durable bounded-retry destruction; a runtime for a running run is never eligible |
| Timezones | Durable timestamps are UTC instants accepted by the control plane; agent processes receive `TZ=UTC`; local rendering belongs to clients |

Redaction prevents accidental known-value leakage. It cannot stop an agent from transforming or exfiltrating a credential it was intentionally given. Use short-lived, least-privilege, per-run credentials.

## Persistence and operations

Container deployment is one command:

```console
export MEANWHILE_API_KEY='<local bootstrap key>'
docker compose up --build
```

The supplied image mounts `/data` as the writable ownership volume and uses `/data/state` as the actual data root, keeping its adjacent single-writer lease durable and writable. Do not run multiple control-plane writers against the same SQLite root.

Maintenance commands acquire the same exclusive lease:

```console
bun run cli -- data backup --output ../meanwhile-backup
bun run cli -- data verify ../meanwhile-backup
bun run cli -- data restore ../meanwhile-backup
bun run cli -- data gc --dry-run
bun run cli -- data gc --apply
```

Backup includes a normalized SQLite snapshot, all referenced workspace/artifact objects, persisted previews, migration identities, and a hash for every file. Restore accepts only an absent or empty destination; garbage collection is explicit dry-run/apply mark-and-sweep.

## Observability

Meanwhile keeps three evidence planes distinct:

1. owner-visible durable run logs;
2. operational JSON logs, manual OpenTelemetry traces, bounded metrics, health, and diagnostics;
3. append-only audit records for mutations and security-sensitive actions.

Prompts, process output, credentials, file contents, and raw provider bodies are forbidden telemetry attributes. OTLP/HTTP export is optional; exporter failure degrades telemetry health, never run correctness.

## Test and release proof

```console
bun run check                       # Biome, types, notices, runner builds, deterministic suite
bun run demo                        # no-account product path
bun run proof:release               # semantic round trip, telemetry, restart, backup/restore
bun run cloudflare:check            # bridge package and protocol contract
bun run test:live:cloudflare        # explicit real-account lifecycle
bun run proof:release:cloudflare    # deterministic remote compatibility proof
bun run proof:release:cloudflare:claude # real model, SDK artifact/deploy, URL, telemetry, recovery
```

The release proof sends a revision-bound token through ACP, structurally verifies the durable response, downloads immutable agent output through the public SDK, deploys those bytes through the SDK, and fetches the returned URL. It also validates OTLP trace and metric semantics, correlated structured logs, byte-scans the live data root and backup for exact private values, verifies exact status and replay evidence, destroys the runtime, restarts, restores into an empty data root, and boots again successfully.

`proof:release:cloudflare` isolates provider/control-plane compatibility with the deterministic ACP fixture. `proof:release:cloudflare:claude` is the acceptance proof for real agent work: Claude receives the task inside Cloudflare Sandbox, creates `site/index.html`, and only the public SDK is used to retrieve and promote the captured artifact. A health response, skipped account test, or deterministic response is never described as real-model proof.

The deterministic suite separately covers owner isolation, lifecycle transitions, log replay, artifacts, cancellation, timeout, concurrent idempotency, deployment audit, secret redaction, restart reconciliation, cleanup safety, provider replacement, and persistence.

## Production status

Meanwhile `v0.1.1` is the current public compatibility baseline. The complete local product path, packaged container topology, and real Cloudflare Sandbox Claude path are implemented and release-proven through artifact download and deployment. A compatibility baseline is not a blanket production-support promise.

Before broad multi-tenant production use, the project still needs:

- signed release attestations and automated package publication;
- continuous real-account verification for every released remote-provider revision;
- quotas, rate limits, and admission control;
- a lease-capable shared database for horizontal control-plane writers;
- object-backed retention for logs beyond provider replay limits;
- a tenant secret manager or host-scoped credential broker for private repository checkout;
- an explicit bidirectional runner channel before interactive human approval can be supported.

These are evolution triggers, not reasons to add distributed machinery to the current single-writer core.

## Documentation

- [Architecture](docs/architecture.md) — control path, authority, races, recovery, and extension rules
- [Provider contract](docs/provider-contract.md) — implement and prove a runtime adapter
- [Operations](docs/operations.md) — configuration, backup, recovery, telemetry, and Cloudflare operation
- [Threat model](docs/threat-model.md) — trust boundaries and residual risks
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Development

Codex produced the initial implementation end to end, including production code, tests, release proofs, documentation, and iterative review. The maintainer set the product model, architectural contracts, and acceptance criteria expressed throughout this README.

Those decisions establish the durable Run as the chain of custody connecting intent, execution identity, evidence, artifacts, and deployment. Authority follows lifecycle: the control plane owns policy and durable state, runtime adapters report compute facts, the colocated runner owns ACP, artifact storage owns immutable bytes, and deployment adapters promote those bytes. Capability declarations, replay cursors, and accepted execution provenance make replaceability and recovery explicit system properties. Semantic release evidence spans agent output, telemetry, cleanup, restart, backup, restore, and deployment.

These contracts are maintained in [AGENTS.md](AGENTS.md) and the architecture, provider, operations, and threat-model documentation, and they govern future contributions.

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
