# Meanwhile

**The trusted system for work you delegate to AI agents.**

[![CI](https://github.com/kohoj/meanwhile/actions/workflows/ci.yml/badge.svg)](https://github.com/kohoj/meanwhile/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun_1.3.13-black)](https://bun.sh/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> Agents and machines are replaceable. Intent and evidence are not.

You hand a task to an AI agent. Then what? You want to know it finished, see what it did, trust it didn't leak a secret or lose your work — without babysitting a terminal. That gap between *delegating* work and *trusting* the result is what Meanwhile closes.

Meanwhile is the durable layer under the agent, not another agent. You give it a task; it runs [ACP](https://agentclientprotocol.com/) agents (Claude Code, Codex, Pi, …) in an isolated runtime, and it stands behind every task like a trusted system: **still tracked after a crash, recoverable after a restart, auditable end to end, and never exposing the credentials the agent used.** A `Run` carries one task to immutable output; an `AgentSession` keeps one agent context alive across ordered `Turn`s. Both survive control-plane restarts. You promote only the immutable output you chose.

> **Status:** the durable core, durable sessions, local runtime, and Cloudflare runtime ship today (`v0.1.3`). A delegator's board — where the people who *asked* for the work watch it close, wait, or recover, and can hand off new work — ships in `v0.1.3` as the isolated [`board/`](board/PRODUCT.md) workspace, verified against a local control plane; it runs from a clone and is not part of the published npm package.

![Meanwhile routes one-shot runs to immutable artifacts and deployments and durable sessions across ordered turns, with representative ACP agents such as Claude Code, Codex, and Pi plus additional agents, shipped Local and Cloudflare runtimes, and an open runtime-adapter contract.](docs/assets/meanwhile-product-map.webp)

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

Requires macOS or Linux, [Bun 1.3.13+](https://bun.sh/), and Git. Every Meanwhile application, CLI, demo, proof, and runtime-local runner process executes with Bun. Cloudflare's bridge executes in `workerd`, while its official deployment tooling may carry its own host runtime; neither introduces Node into the product runtime. The local provider needs no cloud account, but it is **not a security sandbox**.

The fastest way to start the control plane, without cloning anything, is the published package. The standalone runner is compiled once on first start:

```console
# `key generate` prints JSON; keep the key it returns and export it.
bunx @kohoz/meanwhile key generate
export MEANWHILE_API_KEY="mwk_..."
bunx @kohoz/meanwhile serve
```

The API starts at `http://127.0.0.1:7331`; local previews use the separate origin `http://127.0.0.1:7332`. Point the client or CLI at it with the same `MEANWHILE_API_KEY`.

To work on Meanwhile itself, run it from a clone instead:

```console
bun install
cp .env.example .env
bun -e 'import { issueApiKey } from "./src/auth.ts"; console.log("MEANWHILE_API_KEY=" + (await issueApiKey()).key)' >> .env
bun run runtime:build
bun run doctor
bun run dev
```

Startup initializes the exact current SQLite schema on an empty database and rejects every non-matching database before readiness. OpenAPI is available at `/openapi.json`.

To exercise the complete no-account path in one command:

```console
bun run demo
```

That command creates a run, follows logs, captures an artifact, deploys it through `local-static`, and fetches the preview.

## One run, end to end

The typed client is the canonical programmatic interface. It uses Web `fetch`, `AbortSignal`, streams, and the same Zod contracts as the HTTP API. Add it to a Bun client project from npm; `0.1.3` is the current published baseline, and durable sessions ship in it behind local and deterministic proofs, while credentialed `remote-live-agent` conclusions remain per-revision receipts (see the changelog):

```console
bun add @kohoz/meanwhile
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

const deployment = await meanwhile.deployments.create(
  {
    runId: finished.id,
    artifactPath: "dist",
    deployTarget: "local-static",
  },
  { idempotencyKey: `deploy-dist-${finished.id}` },
)

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

### Keep and reuse evidence from an earlier run

The first shared-execution-intelligence primitive is intentionally small: an owner explicitly promotes one bounded text or JSON artifact entry into a discoverable `Brief`, then selects that brief for a later one-shot run. A brief is an immutable reference, not copied memory; the source artifact remains authoritative.

```ts
const prior = await meanwhile.artifacts.list(previousRun.id)
const findings = prior.find((artifact) => artifact.logicalPath === "findings.md")
if (!findings) throw new Error("findings.md was not captured")

const brief = await meanwhile.briefs.create({
  title: "Authentication findings",
  artifactId: findings.id,
})

const next = await meanwhile.runs.create({
  workspace: { type: "bundle", artifactId: currentWorkspaceBundleId },
  agentType: "codex",
  prompt: "Apply the earlier finding to this checkout and verify it.",
  briefIds: [brief.id],
  artifactPaths: ["dist"],
})
```

Brief creation and run admission both authorize the source under the same owner. The accepted run snapshots source run, artifact, path, digest, media type, and byte size; launch revalidates the exact bytes and places delimiter-escaped content in an envelope marked as untrusted historical evidence, not instructions. Nothing is mined, ranked, or attached automatically. The Board exposes the same explicit loop as “keep” on captured text output and “prior briefs” during delegation.

The CLI is a presentation layer over the same client:

```console
bun run cli -- run --agent codex --provider local --files ./workspace --artifact dist -- <task>
bun run cli -- briefs create <artifact-id> --title "Authentication findings" --path findings.md
bun run cli -- run --agent codex --provider local --files ./workspace --brief <brief-id> -- <task>
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
| Briefs | `POST /briefs`, `GET /briefs`, `GET /briefs/:id` |
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
      "networkPolicy": { "allowedHosts": ["api.openai.com"] },
      "credentials": [
        {
          "environmentVariable": "OPENAI_API_KEY",
          "host": "api.openai.com",
          "methods": ["POST"]
        }
      ]
    }
  }
}
```

Claude Code, Pi, and Hermes use the same shape with `claude-agent-acp`, `pi-acp`, and `hermes-acp`. A tool without native ACP needs a small explicit adapter executable; agent-specific output parsing never belongs in the control plane.

The local provider intentionally has no credential-mediation claim. It runs the deterministic, no-account proof only:

```console
bun run demo
bun run proof:release
```

Credential-bearing live-agent proofs run only through the Cloudflare brokered-egress path. The agent receives a revocable placeholder, the bridge substitutes the source credential only on an exact host/method grant, stream-redacts exact values from the upstream response, and denies all other agent-phase egress. `proof:release:cloudflare:codex` requires API-key authentication; ChatGPT session tokens are deliberately not injected because the Codex client must parse them locally. Claude file credentials and metadata-service authentication are likewise rejected instead of being represented as safe.

## Runtime providers

A provider owns isolated compute, process identity and replay, workspace files, optional port exposure, and health. It never sees public owner policy, run-state transitions, artifact retention, deployments, or SQL.

The stable contract is intentionally deeper than `runCommand(string)`:

```ts
interface RuntimeProvider {
  create(input: CreateRuntimeInput): Promise<RuntimeHandle>
  start(runtime: RuntimeHandle): Promise<void>
  inspect(runtime: RuntimeHandle, signal?: AbortSignal): Promise<RuntimeState>
  stop(runtime: RuntimeHandle): Promise<void>
  destroy(runtime: RuntimeHandle): Promise<void>

  spawn(runtime: RuntimeHandle, process: ProcessSpec): Promise<ProcessHandle>
  inspectProcess(process: ProcessHandle): Promise<ProcessState>
  events(process: ProcessHandle, cursor: EventCursor, signal?: AbortSignal): AsyncIterable<ProcessEvent>
  send?(process: ProcessHandle, input: ProcessInput): Promise<void>
  signal(process: ProcessHandle, signal: ProcessSignal): Promise<void>
  wait(process: ProcessHandle): Promise<ProcessExit>

  writeFiles(runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void>
  listFiles(runtime: RuntimeHandle, path: RelativePath, options: ListRuntimeFilesOptions, signal?: AbortSignal): Promise<RuntimeFileInfo[]>
  readFile(runtime: RuntimeHandle, path: RelativePath, options: ReadRuntimeFileOptions, signal?: AbortSignal): Promise<Uint8Array>
  expose?(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint>
  health(): Promise<ProviderHealth>
}
```

`local` is the deterministic reference implementation. `cloudflare` is a real provider backed by the official Cloudflare Sandbox SDK through an independently deployable, authenticated bridge. The SDK, digest-pinned base image, standalone runner's Bun runtime, and bundled ACP toolchains are pinned as one compatibility unit; the root `packageManager` is the single Bun-version source and Cloudflare types remain inside the provider package. The image gate proves that the exact Codex, Claude Code, and Pi adapter/runtime executables are installed and bootable; only a successful credentialed live-agent receipt on the same clean revision proves an end-to-end agent path. Production operators can derive smaller agent-profile images from the same contract without changing the control plane. One bounded transport-retry boundary preserves operation identity; event replay preserves its durable cursor. The bridge durably reserves each process before spawn, records its immutable terminal result outside the sandbox, and appends an exit-code closure frame to both streams. If the SDK removes an exited process from `getProcess()`, the bridge recovers that same execution through retained `getProcessLogs()` evidence; it withholds the irreversible exit cursor until both matching frames are visible, so neither an admission retry nor an eventually consistent terminal read can duplicate work or discard a delayed tail.

The pinned Sandbox SDK does not expose ongoing stdin after process creation. Meanwhile therefore does not claim generic interactive process I/O: the bridge durably binds each `(process, sequence)` to one secret-safe command fingerprint, then publishes a validated command to a provider-private mailbox. Exact retries are harmless; conflicting reuse fails closed. This is a capability-gated runner command transport, not remote ACP, a PTY, or a second control plane.

The shipped Cloudflare image uses `standard-1` deliberately: a credentialed Claude coding-agent process observed during image sizing exceeded the `lite` class's 256 MiB limit. That observation informs capacity; it is not current-revision release evidence. Deterministic bridge checks can fit smaller compute, but the supported live-agent proof must use a class sized for the agent toolchain. Runtime destruction remains the cost boundary.

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
bun run proof:release:cloudflare:codex    # credentialed Codex agent → artifact → deploy → URL
bun run proof:release:cloudflare:claude   # same live-agent proof through Claude Code
bun run proof:release:cloudflare:pi       # same live-agent proof through Pi
bun run proof:verify -- .proof/cloudflare-codex.json
```

To add Daytona, Fly Machines, Modal, or another backend, implement `RuntimeProvider`, declare truthful capabilities, and pass the shared provider contract plus a real-account lifecycle proof. The run executor contains no provider-name branches. See [Provider contract](docs/provider-contract.md).

## One-click deployment

`POST /deployments` resolves exactly one `artifactPath` or logical `workspacePath` to immutable stored bytes before invoking a target adapter. It never reads an arbitrary host path or a runtime that may already have been destroyed.

Deployment creation requires an owner-scoped `Idempotency-Key`. The canonical request binds the normalized source selector, target, caller configuration, and secret references. First admission resolves that selector to immutable bytes and atomically commits the binding, deployment record, and create audit. Exact retries return the original record before consulting mutable adapters; conflicting reuse returns `409`.

```console
curl --fail-with-body \
  -X POST http://127.0.0.1:7331/deployments \
  -H "Authorization: Bearer $MEANWHILE_API_KEY" \
  -H 'Idempotency-Key: deploy-dist-1' \
  -H 'Content-Type: application/json' \
  --data '{
    "runId": "<run-id>",
    "artifactPath": "dist",
    "deployTarget": "local-static",
    "config": {},
    "secretRefs": {}
  }'
```

The response is a durable deployment record. The executor stores ordered logs, structured failures, audit evidence, and the validated preview or deployment URL. If target success becomes possible before its durable evidence commits, the record remains `running` for exact-id reconciliation instead of claiming false failure. `local-static` completes the entire flow without a cloud account, verifies its exact immutable publication on reuse, and serves untrusted output on an origin separate from the authenticated API.

New targets implement `DeployAdapter` over an immutable source; they do not receive a Store, RuntimeProvider, or owner identity.

## Data model and correctness

SQLite in WAL mode is the source of truth for one active control-plane writer. It stores relational metadata and references; immutable workspace and artifact bytes live in an owner-scoped content-addressed store under `MEANWHILE_DATA_DIR`.

```text
Owner ── API keys
  ├── Run ── status/events/logs ── immutable artifacts ── deployments
  │    └── runtime create intent ── runtime instance ── process launch intent ── runner cursor ── cleanup state
  └── AgentSession ── Turns ── session events
       └── runtime create intent ── runtime lease ── process/command cursors ── cleanup state
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
| Secrets | Public input stores references only; mediated providers expose revocable placeholders to agents and inject real values only at exact outbound host/method grants; neither values nor placeholders enter durable evidence |
| Idempotency | Run, session, turn, and deployment admission independently bind `(ownerId, Idempotency-Key)` to a canonical request hash; conflicting reuse returns `409` |
| Timeout | Provisioning starts a persisted absolute deadline; the runner receives only a remaining monotonic duration, and post-terminal artifact reads remain bounded by the same deadline |
| Cancellation | One atomic outcome claim commits request audit, immutable `cancelled`, terminal evidence, and cleanup eligibility before signalling |
| Restart recovery | Durable create intents reacquire the same provider runtime by id; persisted handles/cursors then reconnect and deduplicate replay where capabilities permit |
| Cleanup | Terminal work first enters durable credential revocation; runtime destruction is ineligible until revocation succeeds, and active work is never eligible |
| Admission | One-shot runs and new session leases have independent configurable concurrency; already-live sessions are always reattached after restart, and cleanup has its own bounded lane |
| Timezones | Durable timestamps are UTC instants accepted by the control plane; agent processes receive `TZ=UTC`; local rendering belongs to clients |

Session and turn creation use the same owner-scoped idempotency rule independently. Session events bind runner evidence, control-plane transitions, and turn identity to one contiguous durable sequence. A session runtime is never cleanup-eligible while its session is operational; a timed-out or interrupted turn does not destroy continuity.

The `SecretResolver` owns resource-bound control-plane material; the independent `RuntimeCredentialBroker` owns agent-phase egress grants and revocation. Run/session admission rejects secret references when the selected provider cannot mediate them. Cloudflare stores lease material encrypted in bridge Durable Object state, gives the agent only deterministic opaque placeholders, substitutes values inside the trusted Worker outbound handler, stream-redacts exact values from the upstream response, and revokes the lease before runtime destruction. Recovery reattaches the same lease identity and fails closed on conflicting policy or credential material.

This boundary prevents the agent from reading the source credential. It does not make an authorized destination trustworthy or prevent workspace-data exfiltration to that explicitly allowed destination. The built-in environment resolver is still a bootstrap secret source; production tenants need an owner-scoped secret manager and preferably short-lived source credentials.

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

Backup includes a normalized SQLite snapshot, all referenced workspace/artifact objects, and only previews referenced by successful local deployment rows. Preview verification proves the canonical manifest, exact file set, and every size/digest; orphan or tampered publication bytes make backup/verification fail rather than entering the archive. Restore accepts only an absent or empty destination; garbage collection is explicit dry-run/apply mark-and-sweep.

Meanwhile has one current database schema and no upgrade path. A new empty database is initialized atomically and records the exact schema fingerprint; any nonempty database with a missing or different identity is rejected without modification. Schema changes require a fresh data root. Carrying durable data forward requires a separately designed export/import boundary, which does not exist today; Meanwhile never guesses with SQL backfills or dual reads.

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
bun run proof:release:cloudflare:codex  # credentialed live Codex agent
bun run proof:release:cloudflare:claude # credentialed live Claude Code agent
bun run proof:release:cloudflare:pi     # credentialed live Pi agent
bun run proof:verify -- .proof/cloudflare-codex.json
```

Every release-proof command rebuilds the standalone runner and demo agent first; it never accepts a prior `dist/` directory as an implicit prerequisite.

The release proof sends a revision-bound token through ACP, structurally verifies the durable response, downloads immutable agent output through the public SDK, deploys those bytes through the SDK to the explicit `local-static` target, and fetches the returned control-plane preview URL. It also validates OTLP trace and metric semantics, correlated structured logs, byte-scans the live data root and backup for exact private values, verifies exact status and replay evidence, destroys the runtime, restarts, restores into an empty data root, and boots again successfully.

Every command atomically writes a versioned, self-verifying receipt under `.proof/`. Receipts classify evidence as `local-control-plane`, `remote-provider-compatibility`, or `remote-live-agent`; bind the Git commit and dirty state; distinguish deterministic fixtures from credentialed agents; require restored revoked run/session credential leases for live agents; identify `local-static` as the deployment boundary; and state that exact downstream model identity is not attested. `bun run proof:verify -- <receipt> --require-clean --commit=<sha>` verifies its schema, evidence digest, cleanliness, and revision. The manual `Remote proof` GitHub workflow additionally runs the real provider lifecycle, requires a clean checkout, uploads the receipt, and signs its artifact provenance with GitHub's Sigstore-backed attestation service.

`proof:release:cloudflare` isolates provider/control-plane compatibility with the deterministic ACP fixture. The agent-specific commands are credentialed live-agent acceptance proofs: each selected ACP toolchain receives the task inside Cloudflare Sandbox, creates `site/index.html`, preserves one ACP identity across two turns and a control-plane restart, and exposes the captured output only through immutable storage and the public SDK. This proves the configured agent path, not a cryptographically attested model identity. A health response, skipped account test, lifecycle-only check, image version check, or deterministic response is never described as equivalent evidence.

Cloudflare proof admission does not treat `wrangler deploy` completion or another HTTP client as bridge readiness. A deployment workflow first waits on Cloudflare's container-application state until every declared instance is healthy and none are starting, scheduling, or failed, then waits within a fixed budget for the authenticated production Bun `RuntimeProvider.health()` path. Health proves protocol availability, not hidden compute creation; the first Sandbox start remains an idempotent, deadline-bounded provider mutation and absorbs Cloudflare-classified transient transport errors through bounded backoff. Accepting a physical runtime while the container application is still provisioning is invalid because the rollout may replace that generation.

The deterministic suite separately covers owner isolation, lifecycle transitions, run/session replay, cross-turn ACP continuity, conflict policy, interrupt, timeout, artifacts, cancellation, concurrent idempotency, deployment audit, secret redaction, restart reconciliation, cleanup safety, provider replacement, and persistence.

## Production status

Meanwhile `v0.1.3` is the current public release baseline. The complete credential-free local product path, durable sessions, the delegator's board, and the packaged Cloudflare topology are implemented. Deterministic Cloudflare compatibility and each credential-bearing Codex, Claude Code, and Pi path have separate release gates; only a successful clean-revision receipt from the corresponding current command is evidence for that revision. A configured command, installed executable, historical run, or green deterministic CI job is not current live-agent evidence. This branch intentionally carries one current data and execution contract with no alternate path; the release baseline is not a blanket production-support promise.

The deterministic suite proves interrupt, per-turn timeout, replay, and cleanup semantics against replaceable providers. Local release evidence proves the complete host-process product path. Cloudflare release evidence proves one ACP identity across two turns, event replay, cleanup, and control-plane restart on real remote compute; the separate live lifecycle test proves remote hard termination and credential mediation. Cloudflare evidence is bound to bridge protocol v6, an exact runner digest, and the deployed image reference/digest; these remain operator/platform assertions rather than remote attestation.

Before broad multi-tenant production use, the project still needs:

- automated package publication tied to verified release receipts;
- a Pi ACP adapter that propagates an internal model/RPC failure as prompt failure. The exact pinned `pi-acp@0.0.31` currently maps its internal `error` result to ACP `end_turn`; Meanwhile's semantic proof rejects the resulting empty response and publishes no receipt, but that path is not accepted as passed until the adapter boundary is corrected and a clean `remote-live-agent` receipt succeeds;
- continuous real-account verification for every released remote-provider revision;
- owner quotas and request rate limits beyond the implemented process-level admission bounds;
- a lease-capable shared database for horizontal control-plane writers;
- object-backed retention for logs beyond provider replay limits;
- an owner-scoped secret-manager/short-lived issuer backend and a host-bound private-repository checkout broker;
- a versioned permission-response command and explicit approval policy before interactive human approval can be supported;
- provider-neutral suspend/resume semantics before idle sessions can release compute without closing ACP continuity.

These are evolution triggers, not reasons to add distributed machinery to the current single-writer core.

## Roadmap

Meanwhile's direction is to be the durable, trustworthy layer *under* agent work — the thing an application, a team, or the person who requested the work can rely on — rather than another agent or another agent console. Concretely:

- **Shipped (`v0.1.3`).** The durable control plane, durable sessions and turns, the credential-free local runtime, the packaged Cloudflare runtime, and the delegator's board — a read-only, evidence-driven view (with delegate-only write) that answers one question for everyone with a stake in a task, not just the person who launched it: *is it done, is it waiting on someone, or is the system recovering it?* The board is a projection over the durable event stream exposed by `runs.followEvents()` / `sessions.followEvents()` — a view, never a second control plane, and never a way to mutate an existing run.
- **In development — shared execution intelligence.** The first run-to-run loop is implemented: an owner explicitly promotes bounded text/JSON artifact evidence into an immutable, discoverable Brief, then selects it through HTTP, SDK, CLI, or the Board for a later run. Accepted runs retain exact source snapshots with owner isolation, idempotency binding, restart persistence, and runner-time byte revalidation. Automatic extraction, semantic ranking, interactive-session support, and cross-owner sharing are deliberately absent.
- **Then — an open contract.** Hardening the typed client and OpenAPI surface so other tools (boards, IDEs, chat entry points) can run on Meanwhile's durable, credential-mediating, auditable core instead of rebuilding it.

Only the *Shipped* line is release evidence. Everything below it is intent, and this document will not describe those items as implemented until their own proofs exist.

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
