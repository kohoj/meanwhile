# Meanwhile

**Durable infrastructure for agent work.**

[![CI](https://github.com/kohoj/meanwhile/actions/workflows/ci.yml/badge.svg)](https://github.com/kohoj/meanwhile/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun_1.3.13-black)](https://bun.sh/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> Agents and machines are replaceable. Intent and evidence are not.

Meanwhile gives agent work a portable identity. A `Run` carries one task to immutable output. An `AgentSession` keeps one ACP context alive across ordered `Turn`s. Both compose an [ACP](https://agentclientprotocol.com/) agent, a runtime, and policy; both survive control-plane restarts without exposing provider machinery.

Use a run for a fix, migration, evaluation, or release. Use a session when a person or upstream agent needs to inspect, redirect, interrupt, and continue the same agent context. Promote only immutable run output.

```text
                                  immutable Artifact ──► Deployment
                                 /
SDK / HTTP / CLI ──► one-shot Run
                 \
                  └──► durable Session ──► Turn 1 ──► Turn 2 ──► …
                               │
                         Runtime lease
                               │ lifecycle · replay · ordered input
                 RuntimeProvider (local · Cloudflare · …)
                               │
                       meanwhile-runner
                               │ local ACP over stdio
                               ▼
                         any ACP agent
```

## Durable intent is the product

An agent process is a tool. A sandbox is a temporary place to run it. Neither is the durable product boundary.

Meanwhile makes durable intent that boundary: something an application can route, observe, cancel, recover, audit, and—when output is captured—promote without learning the agent harness or infrastructure API underneath it.

Meanwhile keeps four lifecycles separate:

| Entity | Lifetime | Authority |
| --- | --- | --- |
| **Run** | Durable | User intent and authoritative status |
| **Runtime** | Disposable | Provider compute and process facts |
| **Artifact** | Durable, immutable | Content-addressed output bytes |
| **Deployment** | Durable | Auditable promotion of an artifact |

A runtime may disappear without erasing its run. A deployment never reaches back into a mutable workspace. Provider logs report facts; they never decide run state.

Interactive work adds four concepts without weakening those boundaries:

| Entity | Lifetime | Authority |
| --- | --- | --- |
| **AgentSession** | Durable | Continuity policy and current session state |
| **Turn** | Durable | One prompt, deadline, conflict policy, and terminal result |
| **Runtime lease** | Disposable | Compute held for the session, with independent cleanup state |
| **Session event** | Durable, append-only | Replayable cross-turn evidence |

`Run` remains the atomic execution and artifact-promotion unit. `AgentSession` is the interactive continuity unit. Neither is overloaded to imitate the other.

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

The typed client is the canonical programmatic interface. It uses Web `fetch`, `AbortSignal`, streams, and the same Zod contracts as the HTTP API. Pin the exact source revision from a Bun client project; `v0.1.1` is the current tagged baseline, while durable sessions remain in `Unreleased` until the next compatibility tag:

```console
bun add github:kohoj/meanwhile#<commit-or-tag>
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

## One agent context, many turns

A session keeps one ACP child and its context alive. Turns are durable commands, not writes to a remote terminal:

```ts
import { Meanwhile } from "meanwhile"
import { emptySessionTimeline, reduceSessionTimeline } from "meanwhile/timeline"
import { captureWorkspace } from "meanwhile/workspace"

const meanwhile = new Meanwhile({
  baseUrl: process.env.MEANWHILE_URL ?? "http://127.0.0.1:7331",
  apiKey: process.env.MEANWHILE_API_KEY!,
})

const session = await meanwhile.sessions.create(
  {
    workspace: { type: "files", files: await captureWorkspace("./workspace") },
    agentType: "codex",
    provider: "local",
    idleTimeoutMs: 30 * 60_000,
  },
  { idempotencyKey: crypto.randomUUID() },
)

const first = await meanwhile.sessions.send(session.id, "Inspect the failure and propose a fix.", {
  idempotencyKey: crypto.randomUUID(),
  conflictPolicy: "reject",
  timeoutMs: 10 * 60_000,
})

let timeline = emptySessionTimeline()
for await (const event of meanwhile.sessions.followEvents(session.id)) {
  timeline = reduceSessionTimeline(timeline, event)
  if (timeline.turnStatuses[first.id] === "succeeded") break
}

await meanwhile.sessions.send(session.id, "Apply it and run the focused tests.", {
  idempotencyKey: crypto.randomUUID(),
  conflictPolicy: "enqueue",
})
await meanwhile.sessions.close(session.id)
```

`reject` refuses a turn while another is open, `enqueue` preserves order, and `interrupt_and_send` durably interrupts the active turn before starting the replacement. Turn timeout ends only that turn; session continuity remains available. Closing a session is idempotent and releases its runtime through durable cleanup.

The equivalent CLI surface is intentionally small:

```console
bun run cli -- sessions create --agent codex --provider local --files ./workspace
bun run cli -- sessions send <session-id> --conflict reject -- <prompt>
bun run cli -- sessions watch <session-id> --json
bun run cli -- sessions interrupt <session-id>
bun run cli -- sessions close <session-id>
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
| Run evidence | `GET /runs/:id/events`, `GET /runs/:id/logs`, `GET /runs/:id/artifacts` |
| Sessions | `POST /sessions`, `GET /sessions`, `GET /sessions/:id` |
| Session turns | `POST /sessions/:id/turns`, `GET /sessions/:id/turns`, `GET /sessions/:id/turns/:turnId` |
| Session evidence/commands | `GET /sessions/:id/events`, `POST /sessions/:id/interrupt`, `POST /sessions/:id/close` |
| Artifacts | `GET /artifacts/:id`, `GET /artifacts/:id/content` |
| Deployments | `POST /deployments`, `GET /deployments`, `GET /deployments/:id`, `GET /deployments/:id/logs` |
| Providers | `POST /providers/test` |
| Operations | `GET /audit`, API-key lifecycle, `/healthz`, `/readyz`, `/openapi.json` |

Run and session events support cursor pagination and SSE follow over the same durable sequence. `runs.followEvents()` and `sessions.followEvents()` resume with `Last-Event-ID`, deduplicate replay, reject gaps, and honor caller cancellation. `meanwhile/timeline` folds raw ACP updates into presentation-neutral messages, tool calls, plans, usage, statuses, and turn identity without making a UI part of the control plane.

## Agent execution

Meanwhile is harness-neutral because the runtime-local `meanwhile-runner` speaks ACP over stdio. ACP initialization, capability negotiation, session creation, prompting, permission decisions, cancellation, and shutdown stay beside the agent. One-shot runs receive one bounded spec. Durable sessions receive ordered, idempotent commands through a provider mailbox. In both cases ACP remains local; provider APIs transport runner lifecycle and replayable frames rather than pretending to be a remote terminal.

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
bun run proof:release:local:codex
bun run proof:release:local:claude
bun run proof:release:local:pi
```

The demo commands keep the path concise. The release-proof commands additionally exercise a two-turn durable session across a control-plane restart, telemetry, cleanup, backup, and restore. Every command installs an exact adapter/runtime pair into a disposable directory, references existing local authentication only for the agent process, verifies the agent-written artifact, deploys it through the API, and fetches the immutable preview. The Pi proof uses its pinned headless RPC runtime through `pi-acp`; on this bootstrap path it accepts an allowlisted Amazon Bedrock token and region without persisting either value.

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
  send?(process: ProcessHandle, input: ProcessInput): Promise<void>
  signal(process: ProcessHandle, signal: ProcessSignal): Promise<void>
  wait(process: ProcessHandle): Promise<ProcessExit>

  writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void>
  listFiles(runtime: RuntimeHandle, path: RelativePath, options: ListRuntimeFilesOptions): Promise<RuntimeFileInfo[]>
  readFile(runtime: RuntimeHandle, path: RelativePath, options: ReadRuntimeFileOptions): Promise<Uint8Array>
  expose?(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint>
  health(): Promise<ProviderHealth>
}
```

`local` is the deterministic reference implementation. `cloudflare` is a real provider backed by the official Cloudflare Sandbox SDK through an independently deployable, authenticated bridge. The SDK, image, standalone Bun runner, and bundled ACP toolchains are pinned as one compatibility unit; Cloudflare types remain inside the provider package. The reference image proves Codex, Claude Code, and Pi through exact adapter/runtime pairs. Production operators can derive smaller agent-profile images from the same contract without changing the control plane. One bounded transport-retry boundary preserves operation identity; event replay preserves its durable cursor. The bridge appends an internal closure marker to both process streams and withholds the irreversible exit cursor until both markers are visible, so an eventually consistent terminal log read cannot silently discard a delayed tail.

The pinned Sandbox SDK does not expose ongoing stdin after process creation. Meanwhile therefore does not claim generic interactive process I/O: the bridge durably binds each `(process, sequence)` to one secret-safe command fingerprint, then publishes a validated command to a provider-private mailbox. Exact retries are harmless; conflicting reuse fails closed. This is a capability-gated runner command transport, not remote ACP, a PTY, or a second control plane.

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
bun run proof:release:cloudflare:codex    # real Codex generation → SDK download → deploy → URL
bun run proof:release:cloudflare:claude   # same proof through Claude Code
bun run proof:release:cloudflare:pi       # same proof through Pi
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
  ├── Run ── status/events/logs ── immutable artifacts ── deployments
  │    └── runtime instance ── runner cursor ── cleanup state
  └── AgentSession ── Turns ── session events
       └── runtime lease ── process/command cursors ── cleanup state
Shared immutable input bundle references feed either execution shape.
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
| Admission | One-shot runs and new session leases have independent configurable concurrency; already-live sessions are always reattached after restart, and cleanup has its own bounded lane |
| Timezones | Durable timestamps are UTC instants accepted by the control plane; agent processes receive `TZ=UTC`; local rendering belongs to clients |

Session and turn creation use the same owner-scoped idempotency rule independently. Session events bind runner evidence, control-plane transitions, and turn identity to one contiguous durable sequence. A session runtime is never cleanup-eligible while its session is operational; a timed-out or interrupted turn does not destroy continuity.

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

1. owner-visible durable run and session evidence;
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
bun run proof:release:cloudflare:codex  # real Codex, durable session, artifact/deploy
bun run proof:release:cloudflare:claude # real Claude Code, same complete evidence
bun run proof:release:cloudflare:pi     # real Pi, same complete evidence
```

The release proof sends a revision-bound token through ACP, structurally verifies the durable response, downloads immutable agent output through the public SDK, deploys those bytes through the SDK, and fetches the returned URL. It also validates OTLP trace and metric semantics, correlated structured logs, byte-scans the live data root and backup for exact private values, verifies exact status and replay evidence, destroys the runtime, restarts, restores into an empty data root, and boots again successfully.

`proof:release:cloudflare` isolates provider/control-plane compatibility with the deterministic ACP fixture. The agent-specific commands are acceptance proofs for real work: each agent receives the task inside Cloudflare Sandbox, creates `site/index.html`, preserves one ACP identity across two turns and a control-plane restart, and exposes the captured output only through immutable storage and the public SDK. A health response, skipped account test, lifecycle-only check, or deterministic response is never described as real-model proof.

The deterministic suite separately covers owner isolation, lifecycle transitions, run/session replay, cross-turn ACP continuity, conflict policy, interrupt, timeout, artifacts, cancellation, concurrent idempotency, deployment audit, secret redaction, restart reconciliation, cleanup safety, provider replacement, and persistence.

## Production status

Meanwhile `v0.1.1` is the current public compatibility baseline. The complete local product path, packaged container topology, and real Cloudflare Sandbox Codex, Claude Code, and Pi paths are implemented and release-proven through durable multi-turn continuity, immutable artifact download, and deployment. A compatibility baseline is not a blanket production-support promise.

Durable sessions on this branch are proven end to end through both runtime adapters, including one ACP identity across turns, interrupt, timeout, event replay, cleanup, and control-plane restart. Cloudflare evidence is bound to bridge protocol v4, an exact runner digest, and the deployed image reference/digest; these are operator/platform provenance assertions rather than remote attestation.

Before broad multi-tenant production use, the project still needs:

- signed release attestations and automated package publication;
- continuous real-account verification for every released remote-provider revision;
- owner quotas and request rate limits beyond the implemented process-level admission bounds;
- a lease-capable shared database for horizontal control-plane writers;
- object-backed retention for logs beyond provider replay limits;
- a tenant secret manager or host-scoped credential broker for private repository checkout;
- a versioned permission-response command and explicit approval policy before interactive human approval can be supported;
- provider-neutral suspend/resume semantics before idle sessions can release compute without closing ACP continuity.

These are evolution triggers, not reasons to add distributed machinery to the current single-writer core.

## Documentation

- [Architecture](docs/architecture.md) — control path, authority, races, recovery, and extension rules
- [Provider contract](docs/provider-contract.md) — implement and prove a runtime adapter
- [Operations](docs/operations.md) — configuration, backup, recovery, telemetry, and Cloudflare operation
- [Threat model](docs/threat-model.md) — trust boundaries and residual risks
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Development

Codex produced the initial implementation end to end, including production code, tests, release proofs, documentation, and iterative review. The maintainer set the product model, architectural contracts, and acceptance criteria expressed throughout this README.

Those decisions establish the durable Run as the chain of custody connecting atomic intent, execution identity, evidence, artifacts, and deployment, while AgentSession/Turn provide a separate continuity boundary for iterative work. Authority follows lifecycle: the control plane owns policy and durable state, runtime adapters report compute facts, the colocated runner owns ACP, artifact storage owns immutable bytes, and deployment adapters promote those bytes. Capability declarations, replay cursors, command identities, and accepted execution provenance make replaceability and recovery explicit system properties. Semantic release evidence spans agent output, telemetry, cleanup, restart, backup, restore, and deployment.

These contracts are maintained in [AGENTS.md](AGENTS.md) and the architecture, provider, operations, and threat-model documentation, and they govern future contributions.

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
