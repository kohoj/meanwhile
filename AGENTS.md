# Meanwhile — Product and Engineering Specification

This file is the source of truth for Meanwhile and the operating contract for every agent working in this repository. Keep implementation, tests, README, examples, and this specification aligned in the same change.

Build an open-source product, not a take-home artifact: small enough to hold in one mind, complete enough to trust, and deep enough that a new runtime, agent, or deployment target does not change the control-plane core.

## 1. Product

Meanwhile is the open control plane for running any coding agent in any isolated runtime.

> Bring your agent. Bring your sandbox. Meanwhile owns the run.

The user supplies a repository or files, an ACP agent, work, and a runtime provider. A one-shot `Run` carries one task to immutable output. A durable `AgentSession` keeps one ACP context alive across ordered `Turn`s. Meanwhile provisions compute, records durable evidence, cleans up disposable resources, and can deploy captured run output through an API, SDK, or CLI.

```text
meanwhile run --agent codex --provider cloudflare --repo <url> -- <task>
meanwhile logs <run-id> --follow
meanwhile deploy <run-id> --artifact dist --target local-static --idempotency-key <key>
meanwhile sessions create --agent codex --provider cloudflare --repo <url>
meanwhile sessions send <session-id> --conflict reject -- <task>
meanwhile sessions watch <session-id> --json
```

The original challenge is the acceptance floor. The product bar is that a failed remote run can be explained, cancelled, recovered, or cleaned up without SSH access.

The current product milestone is the shared Project watch: people in one Project can see work that any member delegated, open its durable conversation and evidence, and add append-only comments without gaining control of another member's agent. The durable execution core makes that collaboration trustworthy; the Board makes it visible. This outcome is not implemented yet. The controlling route and acceptance gates are in [`docs/project-collaboration.md`](docs/project-collaboration.md).

Meanwhile is not a generic shell API, agent/model provider, workflow engine, provider-specific wrapper, secrets manager, CI system, IDE, or dashboard. Do not add Redis, Kafka, a distributed queue, DAG engine, DI container, ORM, MCP facade, second remote provider, or UI merely to look complete.

## 2. The design in one sentence

The control plane owns durable intent and policy; runtime adapters own disposable compute; the runtime-local runner owns ACP; artifact storage owns immutable bytes; deploy adapters promote those bytes.

Four entities must never collapse into one lifecycle:

1. **Run** — durable user intent and authoritative status.
2. **Runtime** — disposable compute used by a run.
3. **Artifact** — immutable, content-addressed output.
4. **Deployment** — auditable promotion of an immutable artifact.

Interactive continuity adds four entities without changing those lifecycles:

1. **AgentSession** — durable continuity intent and authoritative session state.
2. **Turn** — one durable prompt, deadline, conflict policy, and terminal result.
3. **RuntimeLease** — disposable compute retained for a session with independent cleanup state.
4. **SessionEvent** — the append-only, replayable cross-turn evidence stream.

A `Run` remains the atomic execution and promotion unit. An `AgentSession` is the interactive continuity unit. Do not add optional fields until one entity can impersonate the other.

A `Brief` is not another execution lifecycle. It is an immutable, owner-curated reference from reusable context back to authoritative artifact evidence.

Project collaboration adds identity and visibility, not another execution lifecycle. `Owner` remains the tenant boundary; a future `Actor` is durable person/service identity; `ProjectMembership` grants Project capabilities; `Run` and `AgentSession` remain execution truth; an append-only `Comment` remains collaboration evidence and never silently becomes agent input. API keys are credentials, not durable people. These target contracts are unimplemented until their matching source and proofs land.

```text
User / upstream agent
        │ HTTP / SDK / CLI
        ▼
┌─────────────────────────────────────────────┐
│ Meanwhile control plane                    │
│ run/session intent · policy · audit · state│
└──────────────┬───────────────┬──────────────┘
               │               │
       RuntimeProvider     DeployAdapter
               │               │
      ┌────────┴───────┐       └── local-static
      │                │
 local runtime   Cloudflare bridge
      │                │
      └──── meanwhile-runner ───┘
                    │ local ACP over stdio
                    ▼
                 ACP agent
```

The control plane decides. Adapters execute and report facts. ACP stays local to the runner and agent.

## 3. Fixed stack: one owner per concern

Use the smallest current primitive that owns each responsibility completely.

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime, packages, scripts, tests, bundling | Bun | One toolchain; native process, streams, SQLite, hashing, and standalone executable support |
| Language | strict TypeScript | One typed contract language across API, core, runner, and bridge |
| HTTP | Hono on Bun Web APIs | Small, Web-standard, portable; no Node server shim |
| Public client | Typed resource namespaces over `fetch`, `AbortSignal`, Web streams, and shared Zod contracts | One deep consumer interface for SDK, CLI, demos, and upstream agents without server or provider coupling |
| Validation and OpenAPI | Zod 4 + `@hono/zod-openapi` | Runtime validation and API documentation from one schema source |
| Agent protocol | official `@agentclientprotocol/sdk` | Harness-neutral typed ACP instead of per-agent CLI scraping |
| Persistence | `bun:sqlite` in WAL mode | Durable local control plane without an ORM or sidecar |
| Local execution | `Bun.spawn` with argv arrays and Web streams | No shell interpolation and no compatibility layer |
| Remote runtime | official Cloudflare Sandbox SDK behind a bridge | One real remote provider with lifecycle, process, file, and preview primitives |
| Telemetry API | `@opentelemetry/api` | Vendor-neutral trace and metric semantics at ownership boundaries |
| Telemetry SDK/export | OTel base SDK + OTLP/HTTP, behind a Bun contract test | Standard backend interoperability without Node auto-instrumentation |
| Structured logs | a small JSON logger in `src/telemetry.ts` | Stable fields, direct redaction, no logging framework |
| Formatting and linting | Biome | One fast quality tool instead of ESLint plus Prettier |
| Tests | `bun:test` | Same runtime as production; Cloudflare package may use official Worker tooling where required |

Production dependencies must earn their place in this table. Pin the exact Cloudflare Sandbox package, base-image digest, standalone runner Bun version, and agent toolchains as one compatibility unit. The root `packageManager` is the single Bun-version source. Keep provider-only SDKs inside their provider package.

Do not use `@hono/node-server`, Express, Fastify, `better-sqlite3`, `dotenv`, `tsx`, a root Vitest setup, Pino, a DI framework, OTel `NodeSDK`, or the OTel auto-instrumentation metapackage. The OTel JavaScript SDK declares Node support rather than Bun support, so exporters are enabled only after `test/contracts/telemetry.test.ts` proves the exact pinned packages under Bun; exporter failure degrades telemetry health, never run correctness.

“Bun, not Node” means every Meanwhile application process and the runner use Bun. A Cloudflare Worker executes in `workerd`; official Wrangler tooling may itself require Node. Do not hide that provider-tooling fact or introduce Node into the product runtime because of it.

## 4. Ownership boundaries

### 4.1 Control plane

The control plane exclusively owns:

- authentication, owner identity, and authorization;
- run, session, turn, brief, and deployment records, with state machines only for lifecycle entities;
- idempotency and concurrency decisions;
- secret-reference resolution, lifetime, and redaction policy;
- durable run/session event streams, run logs, artifact metadata, and audit evidence;
- timeout, cancellation, reconciliation, and cleanup policy;
- normalized errors, API, SDK, CLI, and OpenAPI contracts.

It never exposes provider handles publicly and never treats provider state or logs as authoritative run state.

### 4.2 Runtime provider

A `RuntimeProvider` owns only:

- isolated-compute create, start, inspect, stop, and destroy;
- process spawn, inspect, event replay, ordered/idempotent input when declared, signal, and wait;
- workspace file write, list, and read;
- optional port exposure;
- provider health and provider-native identifiers.

It never owns prompts, agent types, owner policy, run statuses, audit actions, artifact retention, deployment policy, API shapes, or SQL. Provider selection disappears behind the registry before execution begins. No provider-name branch may appear in `run-executor.ts`.

### 4.3 Runtime-local runner

`meanwhile-runner` is a small data-plane component colocated with the agent. It owns:

- launching the configured agent with an executable and argv, never a shell string;
- ACP initialize, capability negotiation, session creation, one-shot or ordered multi-turn prompting, events, cancellation, and shutdown;
- applying a predeclared non-interactive permission policy;
- translating ACP updates and agent stderr into bounded, sequenced protocol frames;
- enforcing the accepted relative timeout budget with a monotonic clock and terminating the child process group.

It never authenticates owners, selects providers, writes the control-plane database, decides durable run state, retains artifacts, or deploys. It is not a second control plane.

ACP remains local between runner and child. Cloud-provider process APIs transport runner lifecycle, sequenced output, and—only when capability-declared—versioned runner commands; they are not stretched into a remote ACP pipe. An agent without native ACP requires a small explicit ACP adapter executable, not parsing rules in the control plane.

### 4.4 Artifact and deployment boundaries

`ArtifactStore` owns immutable bytes. SQLite owns metadata and references only.

A `DeployAdapter` receives a validated immutable artifact plus target configuration. It reports status, logs, a structured error, and URLs. It never authorizes an owner, reads a mutable runtime workspace, or updates run state.

## 5. Stable contracts

Contracts are serializable, provider-neutral, and executable against a deterministic fake.

### 5.1 RuntimeProvider

`src/providers/runtime-provider.ts` is the only stable compute contract:

```ts
interface RuntimeProvider {
  readonly name: string
  readonly capabilities: RuntimeCapabilities
  readonly provenance: RuntimeProviderProvenance

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

  writeFiles(runtime: RuntimeHandle, files: RuntimeFile[]): Promise<void>
  listFiles(runtime: RuntimeHandle, path: RelativePath, options: ListRuntimeFilesOptions, signal?: AbortSignal): Promise<RuntimeFileInfo[]>
  readFile(runtime: RuntimeHandle, path: RelativePath, options: ReadRuntimeFileOptions, signal?: AbortSignal): Promise<Uint8Array>

  expose?(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint>
  health(): Promise<ProviderHealth>
}
```

This is intentionally deeper than `runCommand(string)`: cancellation, recovery, replay, process identity, files, and cleanup are product semantics.

Rules:

- handles are opaque, versioned, and persistable; core code never inspects private fields;
- capabilities describe provider-neutral facts such as process recovery, event replay, process input, and port exposure; policy may branch on capabilities, never provider names;
- arguments are arrays; paths are normalized relative paths;
- providers preserve the declared portable file mode; executable intent is immutable workspace input, not adapter-specific metadata that core may discard;
- process spawn is idempotent for `(runtime, processId, complete ProcessSpec)`; exact retries return the same process and conflicting reuse fails closed;
- process events have a monotonic provider cursor for reconnect without duplication;
- process input binds each positive sequence to one command identity; exact retries are idempotent and conflicting reuse fails closed;
- runtime creation is idempotent for the exact control-plane runtime identity; a conflicting reuse fails closed rather than allocating different compute;
- `expose` publishes an already-ready service; workload readiness is explicit evidence from the process, never inferred from provider process creation;
- `stop` and `destroy` are idempotent; missing during cleanup means already absent;
- errors preserve provider, operation, safe provider code, and retryability before normalization;
- providers never receive a database handle.

Agent credentials use a sibling `RuntimeCredentialBroker` contract rather than expanding compute ownership. The control plane durably records an exact lease intent before attachment. A broker receives real values plus exact host/method grants, returns only opaque environment placeholders, makes agent-phase egress default-deny, substitutes values only inside its trusted outbound boundary, scrubs exact source values from the response stream, and revokes idempotently by stable lease identity. Runtime destruction is ineligible until durable revocation succeeds. Providers without this contract reject secret-bearing run/session admission; local execution is not granted an exception.

### 5.2 Runner protocol

`runner/protocol.ts` is the versioned control-plane-to-runner data contract.

`RunnerSpec` is the one-shot contract: run identity, validated agent argv and logical working-directory policy, prompt, permission policy, artifact declarations, a remaining relative timeout budget, non-secret environment, and credential-placeholder environment names. `SessionRunnerSpec` launches the same runner in multi-turn mode without a prompt. Subsequent `turn.start`, `turn.interrupt`, and `session.close` commands are versioned, positively sequenced, durably bound to one identity, and delivered only through a provider that declares `processInput`.

The control plane remains the owner of persisted absolute deadlines; immediately before spawn or turn dispatch it converts remaining policy time into a bounded duration. The runner enforces that duration with `performance.now()`, so sandbox clock skew cannot extend or prematurely terminate work. The provider sets the physical workspace as process cwd; no provider-private absolute path crosses the protocol. Real agent credential values never cross into the runner or runtime; only broker-issued placeholders travel in the process environment, never in either serialized spec or command.

Before one-shot spawn, the control plane persists a run-process launch intent containing only runtime/process identity and the accepted relative timeout budget. This freezes the otherwise time-varying process spec across the spawn-before-handle-persistence crash window without persisting secret values. Exact provider spawn retry then reacquires the same process; handle, public process identity, and audit materialize atomically.

Runner stdout is NDJSON protocol only. Every frame includes protocol version, run or session identity, monotonic runner sequence, timestamp, type, and a bounded validated payload. Session turn frames also carry turn identity. Runner diagnostics use stderr. The control plane validates and deduplicates by runner sequence, verifies exact replays, then durably stores accepted evidence.

Runner-side redaction is defense in depth, not a trust boundary. The control plane retains both resolved values and issued placeholders in its redactor for the entire output-observation lifetime and redacts agent-controlled fields again before SQLite accepts a frame. Protocol identities, terminal outcomes, and other control fields are never rewritten by a coincidental match.

The provider event stream is the live path and provider-owned replay buffer. The database is the durable authority. Do not invent a “protected runner journal” inside the same sandbox: sandbox processes share a security context, so it is not a trustworthy boundary. A provider may spool output outside agent-writable storage, but correctness cannot depend on pretending the agent cannot observe or tamper with same-sandbox resources.

The same standalone Bun runner executable is installed outside the workspace for local and Cloudflare execution. This keeps behavior identical; it is an integrity and packaging choice, not a claimed sandbox boundary.

Agent processes run with `TZ=UTC`. Public and durable timestamps are UTC ISO 8601 instants generated at the control-plane acceptance boundary; runner/provider wall-clock timestamps are diagnostic input, never authoritative ordering. User-local rendering belongs to the consuming SDK, CLI, or UI.

### 5.3 Agent catalog

`config/agents.json` is the only source of agent launch configuration. Each entry declares ACP transport, executable, argv, working-directory policy, expected capabilities, allowed non-secret environment names, exact non-credential egress hosts, and exact credential environment/host/method grants. Validate once at startup and fail fast. No hidden commands or agent conditionals belong in routes or the executor.

Executables are bare portable PATH names, never control-plane host paths. At run creation, snapshot the selected non-secret launch definition, capability-derived permission policy, definition digest, and catalog digest into durable run intent and include that snapshot in idempotency. Execution and recovery use the snapshot rather than re-reading mutable catalog configuration. The shipped catalog lists only bundled runnable agents; examples for external ACP adapters live in documentation, and remote executable availability is proved by the provider image and live test.

### 5.4 Execution provenance

Run acceptance snapshots one self-verifying `ExecutionProvenance`: agent definition and catalog digests, runner digest when known, provider adapter version, capability digest, pinned runtime image reference/digest when known, and bridge protocol version. This snapshot participates in idempotency and persists with the run.

Execution and recovery fail closed before compute if the configured adapter, capabilities, runner, image assertion, or bridge protocol no longer matches the accepted snapshot. A run without valid provenance violates the persisted contract and is rejected; there is no alternate execution or read path. Provenance is evidence of the configured execution identity; an unavailable platform image digest stays `null` rather than being fabricated.

### 5.5 Store

`src/persistence/store.ts` is the only SQL layer. Routes, services, providers, and deploy adapters issue no SQL directly. Public reads of owned resources require `ownerId` in their method signature; narrowly named internal reads exist only for trusted executors. Run, session, turn, brief, command, event, lease, and cleanup transitions commit their related audit/state evidence atomically.

### 5.6 ArtifactStore and DeployAdapter

Artifacts are content-addressed and record owner ID, run ID, logical path, kind, SHA-256, media type, byte size, storage key, and creation time. Writes are atomic; reads are owner-scoped; bytes never mutate in place.

Deployment input is an artifact reference or captured workspace snapshot, never an arbitrary host path or live runtime path.

### 5.7 Shared execution intelligence

Shared execution intelligence reuses the artifact boundary; it is not a second memory store, truth source, vector index, or hidden prompt history. `Brief` is an immutable, owner-curated reference to one bounded text or JSON entry in an earlier run artifact. Promotion validates the entry and exposes a human title plus the exact source identity and credential-free source-workspace basis without copying bytes. A new one-shot run or interactive turn selects ordered brief IDs; admission owner-authorizes each brief and source, revalidates the immutable entry, and snapshots source run, workspace basis, artifact, path, digest, media type, and byte size into that run or turn's durable intent. The ordered snapshots participate in the resource's idempotency.

Immediately before one-shot runner launch or interactive `turn.start` delivery, the control plane re-reads each selected entry through the owner-scoped artifact service and fails closed if any byte identity or snapshotted source-workspace basis no longer matches. After workspace preparation records the run or session's current resolved commit, a pure provider-neutral comparison classifies each entry as `exact`, `same_repository_changed`, `same_repository_unresolved`, `different_workspace`, or legacy `unknown`. The control plane places that classification, both workspace bases, and the bounded content in a versioned, delimiter-safe execution-context envelope ahead of the current task. The envelope states that prior agent output is untrusted historical observation, not instruction, and that workspace relationship is provenance rather than proof of truth. Explicit owner selection authorizes reuse; it does not make agent-produced text true or safe from prompt injection.

The initial contract is deliberately explicit and artifact-to-run/turn. A turn's Briefs apply only to that turn; an AgentSession never gains ambient hidden attachments. The live ACP context may naturally retain what an earlier turn discussed, but durable reuse authority stays with the selecting turn. The system does not automatically mine logs, rank memories, share across owners, mutate source artifacts, or publish session conversation as intelligence. Those require separate durable contracts rather than optional behavior hidden in the runner.

### 5.8 Project collaboration

Project collaboration is the active product milestone. The current source has only owner-wide authorization: bearer authentication yields `ownerId` plus `apiKeyId`, every key under an owner has the same authority, and the Board holds one owner key. It has no Project, stable Actor, membership, immutable delegator identity, comment, mention, or project-scoped stream. Never describe the current Board as multi-person collaboration.

The target boundary is defined in [`docs/project-collaboration.md`](docs/project-collaboration.md). Its controlling rules are:

- collaboration occurs inside one owner; never punch cross-owner sharing exceptions;
- an API key authenticates one stable Actor but never substitutes for that Actor's identity;
- Project is an explicit collaboration boundary and never inferred from repository URL or workspace input;
- new Runs and AgentSessions bind immutable Project and delegating Actor identity while their existing executors remain the only lifecycle owners;
- Project members may read authorized conversation/evidence and append comments, but another Actor's existing work remains non-operable;
- comments use a separate append-only collaboration contract and never enter RunEvent, SessionEvent, prompts, or agent context implicitly;
- every derived resource follows the authoritative Run/Session Project relationship; owner equality alone is insufficient once multiple Actors and Projects exist;
- Fact discovery and further Brief expansion are frozen until the two-person Project proof passes. The implemented Brief kernel remains supported, but it is not the current roadmap gate.

## 6. Run state machine

Public statuses are exactly:

```text
queued → provisioning → running → succeeded
  │           │             ├──→ failed
  │           │             ├──→ cancelled
  │           │             └──→ timed_out
  │           └────────────────→ failed | cancelled | timed_out
  └────────────────────────────→ cancelled
```

Terminal statuses are immutable. Runtime cleanup is a separate lifecycle and never invents a run status.

`src/services/run-executor.ts` is the sole status owner. A route may request cancellation and a provider may report facts; neither mutates run status. Each accepted transition atomically writes:

1. the run row with incremented status version;
2. an append-only status event;
3. the required audit record.

Outcome arbitration has two explicit store transactions because runner completion may precede artifact capture. Atomic acceptance of a validated runner terminal frame reserves that exact result together with its immutable log and prevents a later cancellation, timeout, or control-plane failure from replacing it. If another terminal outcome commits first, the runner frame is retained as `terminal.late` and reserves nothing. Artifact capture remains bounded by the run's original absolute deadline; expiry records a structured capture failure but cannot replace the reserved runner result. After that bounded attempt, `claimRunOutcome` commits the public terminal status, status event, audit, terminal system log, and cleanup eligibility together. Restart recovery reads only the reservation; it never reconstructs one from logs.

The state machine still has exactly three status-mutation entrances: `claimRunProvisioning` owns `queued → provisioning`; acceptance of the validated `session.started` runner frame owns `provisioning → running`; `claimRunOutcome` owns every public terminal transition. Terminal-frame reservation is durable evidence arbitration, not a fourth status transition. No generic transition method or replay repair path exists.

`running` means ACP initialization and session creation succeeded, not merely that a process exists. Logs never determine status. A late exit never overwrites an already claimed terminal result.

`succeeded` means the ACP agent returned the protocol's successful terminal outcome; it does not certify that the user's task acceptance criteria were met. Higher-level proofs validate declared artifacts, tests, or deployments separately. Never scrape agent prose or adapter-specific metadata to reinterpret the protocol result.

A run records authenticated owner ID, immutable workspace input, agent type, prompt, non-secret env, secret references, provider, accepted context-artifact snapshots, artifact declarations, timeout and absolute deadline, status/version, opaque runtime/process references, timestamps, and normalized terminal evidence.

### 6.1 Idempotency

`POST /runs` accepts `Idempotency-Key`, scoped to `(ownerId, key)`. Persist a canonical request hash with the run in one transaction:

- same key and hash returns the original run;
- same key and different hash returns `IDEMPOTENCY_CONFLICT` with 409;
- concurrent duplicates create exactly one run.

### 6.2 Timeout

Timeout starts when provisioning is claimed, so provider startup is bounded. Persist the absolute deadline in the control plane; pass only the remaining relative budget to the provider and runner. Runner and control plane independently enforce the same policy using their own monotonic elapsed-time checks where possible. The winner atomically claims `timed_out`, terminates or stops compute as needed, and schedules cleanup. Late success cannot replace it.

### 6.3 Cancellation

Cancellation is a command to the executor:

- queued: claim `cancelled` without creating compute;
- provisioning/running without a reserved runner result: atomically claim `cancelled` with request/result audit and cleanup eligibility, then signal the runner process group and stop compute;
- repeated cancellation is idempotent;
- cleanup failure is visible but never rewrites the cancelled result.

### 6.4 Restart reconciliation

An API restart is not itself an agent failure:

- queued runs remain claimable and terminal runs remain immutable;
- provisioning/running runs reconnect through persisted opaque runtime/process handles and last accepted cursors;
- provider replay is ingested and deduplicated before finalization;
- a still-active process continues;
- an exited process finalizes from replayed terminal frames and process exit facts;
- a missing or unrecoverable runtime becomes structured `RUNTIME_LOST` after bounded reconciliation;
- runtime creation is preceded by a durable provisioning intent; if allocation succeeded before handle persistence, exact-id create reconciliation materializes and cleans up the same logical runtime;
- orphaned or uncertain runtimes enter durable cleanup;
- all durably accepted history remains readable.

Recovery strength is an explicit `RuntimeCapabilities` value, not a fabricated universal guarantee.

### 6.5 Cleanup

Runtime provisioning intents durably cover the create side effect before a provider call. Runtime instances then carry cleanup state: pending/running/succeeded/failed, attempts, last safe error, and next eligible attempt. Agent credential leases have their own durable attach/active/revoke lifecycle. Terminalization schedules revocation atomically; a runtime is not destruction-eligible until its lease is `revoked`. The reapers reacquire exact identities for interrupted claims and destroy only terminal or abandoned runtimes, never a runtime for running work. Reconciliation, revocation, and destruction are idempotent, audited, observable, and retried only through explicit bounded backoff. A terminal runtime without a cleanup schedule is an invariant violation, not state to auto-repair. Cleanup never deletes run history, logs, artifacts, deployments, or audit records.

### 6.6 Durable run events

Every accepted run transition, validated runner event, run log, captured artifact, and cleanup result also enters one owner-scoped `RunEvent` journal with a contiguous public sequence. `GET /runs/:id/events` exposes cursor pagination and resumable SSE over that sequence. Raw logs remain available as a focused resource view; the event journal is the canonical material for agent-facing timelines. `src/timeline.ts` is a pure reducer, not stored derived state or a UI contract.

### 6.7 Durable interactive sessions

Interactive execution is a sibling of `Run`, not a mode flag on it:

```text
AgentSession: queued → provisioning → idle ⇄ running → closing → closed
                    └───────────────────────────────→ failed | continuity_lost

Turn: queued → running → succeeded | failed | interrupted | timed_out
```

`src/services/session-executor.ts` is the sole session/turn execution owner. The store owns atomic claims and journals; routes only authenticate, validate, and request commands. Session creation snapshots the same workspace identity, agent definition, provider capabilities, and execution provenance used by a run, then persists the resolved repository commit after preparation. A turn may explicitly select ordered Brief IDs; admission freezes the same bounded context snapshots used by a run into turn intent and idempotency, and dispatch revalidates and renders them immediately before `turn.start` without attaching them to later turns.

Each turn has its own persisted absolute deadline. The control plane and runner enforce the same remaining relative budget independently. `interrupted` and `timed_out` terminate one turn without closing the ACP session. A runner or runtime that cannot be reconnected becomes `continuity_lost`; it is never silently replaced with a fresh agent context.

Concurrent input is explicit policy:

- `reject` returns a conflict while any queued or running turn exists;
- `enqueue` commits the turn behind existing work;
- `interrupt_and_send` atomically queues an interrupt before the replacement turn;
- each session and each turn has its own owner-scoped idempotency key and canonical request hash.

A durable session-runtime provisioning intent precedes lease creation. The runtime lease persists opaque runtime/process handles, provider and runner cursors, command sequence, cleanup state, attempts, safe error, and retry schedule. Provider acknowledgement or a recovered `running` observation records the first `runtime.start` audit idempotently, closing the remote-start-before-audit crash window. Session process-handle materialization commits the lease handle, public process identity, and `agent.start` audit atomically; an exact retry is idempotent and any split identity fails closed. Operational sessions are never cleanup-eligible. Closing is idempotent, terminalizes unfinished turns, and schedules durable bounded-retry destruction. A service restart recovers interrupted create/cleanup claims, reconnects the same process, replays and exactly deduplicates runner evidence, resumes undispatched commands, and preserves the same ACP agent-session identity when provider capabilities permit.

New run and session admission are independently bounded. Recoverable sessions are always reattached even when their count exceeds new-session admission capacity; abandoning supervision to satisfy a concurrency number is not a valid optimization. Session cleanup uses a separate bounded lane so long-lived sessions cannot starve runtime destruction. Public history uses keyset/cursor pagination, and one turn is directly addressable without scanning prior turns.

Timeline projection identity includes turn, message role, and ACP message ID. An agent may reuse one ACP message ID for thought and final output; those are distinct presentation facts and must never overwrite one another.

An idle timeout closes the session and releases compute; it does not claim suspend/resume. Interactive permission approval is not implemented until the runner command protocol gains an explicit permission-response command and policy model.

## 7. Workspace, artifacts, and deployment

Workspace input is either a repository URL plus optional revision or an uploaded immutable bundle. Repository credentials are secret references, never embedded in persisted URLs. Record the resolved commit when possible.

Inline upload preparation snapshots and validates all files and computes the canonical manifest identity before writing bytes. Use that identity in idempotency before publication; publish owner-scoped content-addressed bytes and the bundle catalog commit before creating the run. Existing bundle references must be owner-authorized and verified before persistence. Interrupted pre-commit blob publication is explicit garbage-collection input, never silently claimed as a run artifact.

Every workspace path crossing a boundary is relative, normalized, size-limited, and checked against traversal and symlink escape. Core code never relies on a provider's absolute path.

Artifact collection is declared, not an unrestricted filesystem dump. Enforce file count, per-file and total byte limits, path and symlink safety, deterministic manifests and hashes, secret scanning before persistence, and abortable provider reads bounded by the original run deadline. Failed runs may still produce artifacts. Collection failure is separate evidence and does not rewrite the agent result unless an explicit policy says so.

Brief reuse is declared, never ambient. Only explicitly promoted, bounded UTF-8 text or JSON entries may cross into a later run. Owner authorization happens at promotion and run creation, the exact entry identity and credential-free source-workspace basis are persisted with intent, and execution revalidates the source bytes and classifies their relationship to the actual current checkout. A source artifact remains immutable evidence; the later run is a new interpretation, not a revision of the earlier result.

`POST /deployments` requires `Idempotency-Key`, scoped to `(ownerId, key)`, and accepts `runId`, exactly one of `artifactPath` or logical `workspacePath`, a `deployTarget`, non-secret configuration, and secret references. The canonical hash binds normalized caller intent. First admission resolves the source to immutable stored bytes and atomically commits the binding, deployment record, immutable artifact reference, and create audit. An exact replay returns the original deployment before consulting mutable adapters or source catalogs; conflicting reuse returns `IDEMPOTENCY_CONFLICT`. If the source was not captured before runtime cleanup, return `DEPLOYMENT_SOURCE_UNAVAILABLE`.

Deployment statuses are `queued`, `running`, `succeeded`, and `failed`. Store sequenced deployment logs, structured terminal errors, audit evidence, and preview/deployment URLs.

`running` is the durable reconciliation state around an external deployment side effect. Once target success is possible, a deployment-log or success-transaction write failure must leave the record `running`; an exact adapter retry for the stable deployment identity recovers it. Never convert ambiguous external success into a terminal `failed` record.

`local-static` completes this flow without a cloud account. It serves untrusted output on a separate origin/port with defensive headers and an unguessable deployment identity; it never shares the authenticated API origin. Publication, restart reuse, backup, and restore share one canonical manifest and verify the exact file graph plus every size and digest; a matching manifest alone never proves immutable bytes.

## 8. API, identity, and errors

Hono routes validate with shared Zod/OpenAPI schemas, authenticate, call one service, and serialize. They do not orchestrate providers, update status, or access SQL.

`src/client.ts` is the canonical programmatic consumer of this HTTP boundary. It exposes resource namespaces, validated inputs and responses, structured `MeanwhileError`, deterministic waits, and resumable log iteration. It uses only Web transport primitives plus `src/api/contracts.ts`; it never imports application composition, services, provider adapters, persistence, or owner internals. The CLI and demos call this client rather than maintaining a second HTTP stack. Browser use is fail-closed by default because bearer credentials do not belong in untrusted frontend bundles.

Required routes:

```text
POST /runs
GET  /runs
GET  /runs/:id
GET  /runs/:id/events
GET  /runs/:id/logs
POST /runs/:id/cancel
GET  /runs/:id/artifacts

POST /sessions
GET  /sessions
GET  /sessions/:id
POST /sessions/:id/turns
GET  /sessions/:id/turns
GET  /sessions/:id/turns/:turnId
GET  /sessions/:id/events
POST /sessions/:id/interrupt
POST /sessions/:id/close

GET  /artifacts/:id
GET  /artifacts/:id/content

POST /providers/test

POST /deployments
GET  /deployments
GET  /deployments/:id
GET  /deployments/:id/logs

GET    /audit
POST   /api-keys
GET    /api-keys
DELETE /api-keys/:id

GET  /healthz
GET  /readyz
GET  /openapi.json
```

Run logs plus run/session event journals support cursor pagination and SSE follow using the same durable sequence for each resource, so reconnects neither duplicate nor skip accepted evidence.

Never accept `ownerId`, provider handles, storage keys, or host paths from a public body. Bearer API keys derive identity; persist only high-entropy key hashes plus safe prefixes. Cross-owner reads and mutations return `NOT_FOUND`, not forbidden, so existence is not disclosed.

All failures use:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe human-readable message",
    "requestId": "...",
    "details": {}
  }
}
```

Never return provider bodies, stack traces, SQL text, tokens, secret values, prompts, repository credentials, or absolute host paths.

## 9. Persistence

SQLite is the source of truth for a single-active-control-plane topology. Enable foreign keys, WAL, busy timeout, and transactional current-schema initialization; use no ORM.

The store initializes one exact schema only when the database is empty, records its source fingerprint atomically, and rejects every nonempty database whose identity differs. It never upgrades, backfills, repairs, or dual-reads database state. Schema SQL executes statement-by-statement because Bun does not reliably surface every statement-level failure through multi-statement `Database.exec()`.

The schema includes its exact identity, owners and hashed API keys, runs and durable run events, agent sessions, turns, session commands and events, immutable run-input references, durable runtime-provisioning and run-process-launch intents, runtime instances and session runtime leases with cleanup state, runner/provider cursors, independently scoped idempotency keys, sequenced run logs, artifact metadata, deployments and logs, and append-only audit records.

Do not store artifact bodies or resolved secrets in SQLite. Use relational constraints for ownership, ordering, state, and uniqueness rather than hiding invariants in JSON. Owner-scoped indexes start with `owner_id`. State claims use compare-and-swap predicates or status versions.

SQLite deliberately means one active writer. An adjacent lease keyed by the data root's physical filesystem identity excludes a second control plane and all maintenance commands, including access through a symlink alias. Horizontal control-plane scale is a trigger for a lease-capable shared database, not a reason to add distributed machinery now.

`MEANWHILE_DATA_DIR` is one ownership and recovery unit. `meanwhile data backup` requires quiescent durable work, takes a normalized SQLite snapshot, walks every referenced workspace/artifact blob, includes only preview bytes referenced by successful local deployments, and writes a hashed manifest atomically outside the live root. `data verify` rejects missing, extra, linked, or digest-mismatched preview/object bytes and checks schema plus object-graph consistency; `data restore` accepts only an absent or empty destination; `data gc` is explicit dry-run/apply mark-and-sweep and never removes referenced history. Ordinary copying of a live SQLite file is not a backup path.

## 10. Tenant and secret boundary

Tenant isolation is structural:

- all public store methods and indexes scope by owner;
- artifact keys and deployment sources are owner-scoped;
- local runtime directories are owner/run-scoped;
- provider handles never cross the public API;
- previews do not expose authenticated control-plane routes;
- audit queries are owner-scoped until an explicit operator role exists.

Public run input has `env` for persistable non-secret values and `secretRefs` such as `env://OPENAI_API_KEY`. Resolve a secret only immediately before a trusted operation or credential-lease attachment, retain the control-plane copy only for that attachment, and never persist it. Secret-bearing agent work is admitted only when the runtime exposes real credential mediation.

Executors depend on one `SecretResolver` contract that binds resolution to the durable run, session, or deployment identity and returns local sensitive material, its matching redactor, and an awaited release boundary. Release zeroizes only control-plane copies. Agent executors hand that material to `RuntimeCredentialBroker`, which owns a separately persisted, recoverable, revocable lease; setup and deployment credentials remain scoped to their distinct trusted operations. Live artifact scanning covers both real values and capability placeholders. The built-in process-environment resolver is a local-bootstrap source, not a shared tenant namespace: it is deny-all without an explicit catalog, grants only the bootstrap owner, requires source names to match trusted targets, and permanently reserves control-plane/provider variable names. It does not authorize repository credentials because checkout requires a grant bound to both owner and destination host.

Use the narrowest exposure:

- control-plane, provider, and deployment credentials never enter the agent runtime;
- repository credentials enter only the checkout operation when unavoidable;
- model/agent credentials remain in the trusted broker; the agent process receives only revocable opaque placeholders;
- prefer short-lived, per-run source credentials even behind the broker.

Cloudflare Sandbox processes share filesystem and process access inside one sandbox, so process placement is not a secret boundary. Meanwhile closes agent-phase egress to an exact host allowlist and keeps source credential values in the Worker/Durable Object boundary rather than injecting them into that shared sandbox.

Construct the redactor before consuming any output. The same boundary covers run logs, structured logs and span attributes, provider errors, audit metadata, artifacts, and deployment logs. Candidate artifacts containing exact known secret bytes are rejected or quarantined before persistence.

Redaction prevents accidental known-value and placeholder leakage. Credential mediation prevents direct source-credential access; it cannot make an explicitly authorized destination trustworthy or prevent workspace-data exfiltration to that destination.

## 11. Audit and observability

Keep three evidence planes distinct:

1. **Product evidence** — owner-visible run logs plus durable run/session event journals.
2. **Operational telemetry** — structured service logs, traces, metrics, provider diagnostics, and health.
3. **Audit records** — append-only security and mutation evidence.

Every critical event carries applicable request, trace/span, owner, run, runtime, process/session, deployment, provider/operation, status, and version identifiers. High-cardinality IDs belong in logs and traces, not metric labels.

Audit at minimum API-key lifecycle, run/session/turn creation, credential attach/revoke, runtime create/start/stop/destroy, agent start, interrupt/cancellation request and result, timeout, session close/continuity loss, policy-driven artifact rejection, and deployment create/start/success/failure. When audit describes a state change, write it in the same transaction.

Create manual spans at ownership boundaries only: HTTP request, run claim/transition, provider operation, runner launch/reconnect and ACP handshake/turn, artifact collection, deployment, and cleanup. Never attach prompts, URLs with credentials, file contents, process output, or secrets.

Metrics cover run/session queue depth and latency, provisioning, active runs/sessions/runtimes, run and turn outcomes/duration, provider latency/errors, runner replay/gaps/protocol errors, ACP errors, interrupt/cancellation/timeout latency, cleanup backlog/attempts/failures, log volume/rejection, artifact volume/policy rejection, and deployment outcomes. Labels are bounded dimensions such as agent, provider, operation, status, and error code; never owner/run/session/turn IDs, URLs, prompts, or messages.

Structured logs use stable event names and fields; prose belongs in `message`. Telemetry exporter failure never changes run state, but readiness/diagnostics and local logs expose it. `src/instrumentation.ts` initializes telemetry before application imports.

## 12. Provider implementations

### 12.1 Local

The local provider is a POSIX-only full adapter for development, deterministic tests, and the no-account demo. It uses one process-group implementation and the same runner and contract: lifecycle, persistable process identity, replay, ordered/idempotent process input, cancellation, files, artifacts, and exposure where applicable.

It is not a security sandbox. README and provider diagnostics must say so. Never run untrusted code locally while claiming isolation.

### 12.2 Cloudflare Sandbox

`src/providers/cloudflare-provider.ts` talks to the independently deployable bridge in `providers/cloudflare-sandbox/`. The bridge uses authenticated versioned HTTP between the control plane and Worker, then the official Sandbox SDK's HTTP container transport to translate requests into Sandbox/Container/Durable Object primitives.

The bridge:

- authenticates every control-plane request;
- validates opaque handles, operation scope, and relative paths;
- owns no run, owner, artifact, or deployment business state;
- starts the fixed runner as a background process and delivers one validated runner spec as bounded stdin data; the pinned SDK lacks direct initial-stdin support, so the current bridge uses a random provider-private staging file, quoted redirection, and unconditional deletion without placing prompt data in argv;
- supports multi-turn sessions through a capability-gated provider-private mailbox because the pinned SDK has no ongoing stdin primitive; a Durable Object first binds each process sequence to one secret-safe command fingerprint, exact retries are idempotent, conflicting reuse fails closed, and only then is the validated command published to the sandbox;
- exposes cursor-bearing live/replayed stdout frames and separate safe diagnostics;
- durably reserves process identity before spawn and records immutable terminal process evidence in the registry outside the sandbox;
- wraps each process with matching provider-private stdout/stderr exit-code closure frames, recovers an execution from retained logs after the SDK removes its process row, and withholds the irreversible exit cursor until both frames are visible; a missing terminal frame is a retryable provider-evidence failure, never an excuse to publish a guessed tail or launch the process again;
- retries only retryable transport failures with bounded, abortable backoff while preserving operation identity and, for events, the same durable cursor;
- advertises only the hard termination primitive the pinned SDK actually implements; control-plane cancellation then stops remaining sandbox processes through the runtime lifecycle;
- makes stop/destroy idempotent and explicitly destroys rather than confusing sleep with cleanup;
- exposes health without credentials;
- pins Sandbox npm, the custom image, standalone Bun runner, and bundled live-agent toolchains together;
- uses `standard-1` because credentialed coding-agent sizing exceeded `lite` memory; this is a capacity decision rather than current-revision release evidence. The reference compatibility image may bundle multiple agents, while production profile images remain an adapter-level packaging choice;
- installs a deny-all outbound handler before container startup so SDK-managed HTTPS interception and its ephemeral CA are active even with no credential lease; exact-host/method lease handlers are the only overrides;
- stores lease values encrypted in trusted Durable Object state, substitutes opaque placeholders only inside the Worker outbound handler, and stream-redacts exact values from upstream responses;
- passes the shared provider contract and a gated real-account lifecycle test, and ships separate credentialed Codex, Claude Code, and Pi generation/session/download/deployment gates. Only a successful clean-revision receipt from one of those gates is evidence that the corresponding live-agent path passed.

Do not import Cloudflare SDK types into core contracts. Do not use a PTY, repeated process launches, or remote ACP to emulate a session. Do not claim same-sandbox runner files, mailbox files, or environment variables are protected from the agent.

## 13. File ownership

The tree is intentionally boring: a reader should infer the architecture from names alone.

```text
AGENTS.md                         canonical product and engineering contract
README.md                         concise user quick start
CHANGELOG.md                      release-visible behavior and compatibility changes
CODE_OF_CONDUCT.md                community participation contract
biome.json                        one lint/format configuration
config/agents.json                only agent launch catalog

src/instrumentation.ts            first import; telemetry bootstrap
src/control-plane.ts              start/stop/reconcile background ownership
src/app.ts                        dependency composition and Hono app
src/server.ts                     Bun server lifecycle only
src/client.ts                     typed Web-standard public control-plane client
src/timeline.ts                   pure durable-event projections for consumers
src/workspace.ts                  bounded link-free Bun workspace capture
src/workspace-basis.ts            pure evidence/current-workspace relationship semantics
src/cli.ts                        CLI presentation over the public client
src/config.ts                     only environment configuration module
src/version.ts                    package-manifest release version boundary
src/domain.ts                     small shared domain vocabulary
src/errors.ts                     structured error taxonomy
src/auth.ts                       identity boundary
src/secrets.ts                    resolution and redaction boundary
src/credentials.ts                brokered agent credential and lease contract
src/telemetry.ts                  logs, metrics, traces, correlation
src/provenance.ts                 immutable execution identity and drift check
src/data-root.ts                  lease, backup, verify, restore, garbage collection

src/api/contracts.ts              pure public Zod request/response contract
src/api/cursor.ts                 shared strict SSE resume cursor boundary
src/api/                          thin routes and OpenAPI registration
src/services/run-executor.ts      only run-state owner
src/services/run-service.ts       owner-scoped run use cases
src/services/session-executor.ts  only session/turn execution owner
src/services/session-service.ts   owner-scoped interactive use cases
src/services/credential-lease-attacher.ts trusted attach and placeholder boundary
src/services/credential-lease-reaper.ts durable revocation before compute cleanup
src/services/workspace-preparer.ts immutable input to provider workspace
src/services/artifact-collector.ts
src/services/artifact-service.ts  owner-scoped immutable artifact reads
src/services/brief-service.ts     curated artifact reference and run-resolution boundary
src/services/audit-service.ts     owner-scoped audit reads
src/services/api-key-service.ts   owner-scoped API-key lifecycle
src/services/deployment-executor.ts
src/services/runtime-reaper.ts

src/agents/catalog.ts             validated catalog resolution
src/agents/runner-evidence.ts     control-plane runner redaction boundary
src/agents/runner-session.ts      launch/reconnect/event ingestion
src/agents/session-runner.ts      session launch/command/event ingestion
runner/protocol.ts                run/session spec, command, and frame schemas
runner/acp-session.ts             ACP client over local child stdio
runner/acp-supervisor.ts          one ACP context across ordered turns
runner/main.ts                    fixed standalone Bun runner

src/providers/runtime-provider.ts stable compute contract
src/providers/registry.ts         explicit provider resolution
src/providers/local-provider.ts   complete local implementation
src/providers/cloudflare-provider.ts bridge client adapter
providers/cloudflare-sandbox/     isolated Cloudflare package
board/                            isolated delegator board (read-only task lifecycle; creates tasks/briefs through the public client)

src/artifacts/                    immutable storage contract + local store
src/artifacts/workspace-bundle.ts uploaded immutable workspace input
src/deployments/                  deploy contract, registry, local-static
src/deployments/local-static-publication.ts canonical publication verification
src/deployments/local-static-server.ts separate-origin preview serving
src/persistence/                  current schema and the only SQL layer

test/behavior/                    original product invariants
test/contracts/                   replaceability and protocol contracts
test/integration/                 real local composition
test/live/                        credential-gated remote proof
test/fixtures/                    deterministic ACP agent and fakes
scripts/demo.ts                   readable SDK create → logs → artifacts → deploy proof
scripts/demo-environment.ts       hermetic local/live-agent proof setup and teardown
scripts/agent-toolchains.ts       exact local/remote agent proof toolchains
scripts/container-smoke.ts        packaged-image agent and deployment proof
scripts/release-proof.ts          run → Brief reuse → deploy → cleanup → restart → backup release evidence
scripts/release-proof-receipt.ts  versioned proof taxonomy, schema, digest, and atomic receipt
scripts/verify-release-proof.ts   independent receipt/revision verification
.github/workflows/remote-proof.yml explicit real-account proof plus signed receipt provenance
docs/                             architecture, provider authoring, operations
docs/project-collaboration.md     controlling route for the active product milestone
docs/threat-model.md              trust boundaries, attacker model, residual risk
```

Do not create `utils.ts`, `common.ts`, `base-service.ts`, or mirrored interface/implementation forests. Put a helper with its owner; extract a deep module only when it removes real complexity.

The Cloudflare package owns only `protocol.ts`, `worker.ts`, `sandbox.ts`, its Dockerfile/config, and bridge tests. The runner owns only protocol translation and ACP supervision. Keep those surfaces narrow.

## 14. Required proof

Release evidence has exactly three classes: `local-control-plane` for the deterministic host-process system path, `remote-provider-compatibility` for the deterministic ACP fixture on actual remote compute, and `remote-live-agent` for one selected credentialed ACP agent on actual remote compute. A successful proof atomically writes one versioned receipt containing the Git commit and dirty state, exact toolchain and configured execution provenance, bounded semantic evidence, explicit Brief-backed follow-up evidence, explicit `local-static` deployment boundary, and a digest over its canonical payload. Release publication accepts only a clean receipt verified against the exact revision. The explicit remote workflow also retains the receipt and signs its artifact provenance; default CI never impersonates a credentialed remote proof. Receipt version 2 adds shared-execution evidence while the verifier retains version 1 support for already-issued receipts.

`remote-live-agent` proves that the configured credentialed agent path produced the required immutable bytes, reused one explicitly promoted Brief in a separate one-shot run, preserved ACP continuity, and persisted then revoked distinct source-run, Brief-backed-run, and session credential leases before cleanup. It does not cryptographically attest the downstream model identity, so the receipt records model identity as `not-attested` and never derives a `realModel` claim from a CLI option.

Adapter process startup and ACP initialization are not agent correctness. A bundled adapter must propagate model, authentication, and RPC failures as prompt failures; mapping an internal error to `end_turn` is a contract defect. The control-plane run state remains protocol-owned, while release proof independently rejects empty semantic output or missing declared bytes and emits no receipt.

Tests must prove:

- owner A cannot read or cancel owner B's run;
- create then query works;
- status evidence records queued → provisioning → running → terminal in order;
- run events provide one contiguous replayable status/runner/artifact/cleanup timeline;
- logs are durable, cursor-queryable, and followable;
- artifacts are captured and owner-scoped;
- cancellation signals the process and becomes immutable `cancelled`;
- timeout becomes immutable `timed_out` despite a late exit;
- identical idempotent requests create one run and conflicting reuse returns 409;
- accepted execution provenance persists, participates in idempotency, and rejects adapter/capability drift before compute;
- deployment admission is owner-scoped and idempotent, and atomically writes one record, immutable-source reference, and create audit;
- an ambiguous deployment success remains `running` and converges through exact-id reconciliation instead of becoming falsely failed;
- exact secrets and capability placeholders never persist in any log plane, audit metadata, or artifact;
- secret-bearing agent admission rejects providers without credential mediation;
- credential leases expose placeholders only, bind exact host/method grants, fail closed on conflicting retry, and revoke before runtime destruction;
- cleanup never destroys a running runtime, is idempotent, and survives restart;
- provider allocation followed by a crash before handle persistence reacquires the same runtime identity and enters cleanup for terminal run/session work;
- history survives reopening SQLite;
- one data-root lease excludes concurrent writers; backup, verify, restore, and dry-run/apply garbage collection preserve the complete referenced graph;
- replay cannot duplicate logs or transitions;
- recoverable in-flight work reconnects; lost compute becomes `RUNTIME_LOST`;
- one durable ACP session preserves its agent-session identity across multiple turns and a control-plane restart;
- session and turn idempotency are independent, conflict policy is explicit, and interrupt/timeout ends one turn without destroying continuity;
- session event replay is exact and contiguous, owner isolation covers every session surface, and session secrets never enter durable evidence;
- runner-side redaction can be bypassed in a contract test without bypassing the control-plane redaction boundary;
- an operational session runtime lease is never cleanup-eligible; close schedules idempotent bounded-retry destruction;
- public and provider failures always use the structured safe error contract;
- workspace traversal, symlink escape, and undeclared artifact capture are rejected;
- local previews remain on a separate unauthenticated origin with defensive headers;
- the runner performs a real ACP initialize → session → prompt → terminal exchange;
- artifact-store implementations pass one immutable owner-scoped contract;
- a fake and local adapter pass the same provider contract;
- the Cloudflare client passes mock-bridge integration;
- retryable Cloudflare transport operations preserve request identity, and event reads resume from the same cursor without duplicating accepted evidence;
- a gated live test creates, starts, executes, reads files/logs, stops, and destroys a real Cloudflare sandbox;
- Cloudflare deployment proof first observes complete container-application rollout convergence, then live and release proofs gate on bounded authenticated bridge readiness from the production Bun `RuntimeProvider.health()` path. Health does not materialize compute; the first idempotent Sandbox start absorbs provider-classified transient transport errors under the caller's deadline, while replacement after physical-generation acceptance fails closed as `RUNTIME_LOST`;
- the public client authenticates, validates contract responses, preserves structured safe errors, waits deterministically, and reconnects log streams without gaps or duplicates;
- artifact inspection/download, deployment listing, audit queries, and API-key lifecycle are owner-scoped through API, SDK, and CLI;
- sandbox clock skew cannot control durable log timestamps or runner timeout duration, and the ACP child timezone is UTC;
- the no-account demo completes create → run → logs → artifact → local deployment;
- the release proof sends a revision-bound prompt through ACP, downloads the immutable agent-written artifact through the public SDK, promotes one exact entry to a Brief, proves a separate run can reuse that frozen evidence into new immutable output, deploys through the SDK, verifies the returned URL and semantic OTLP signals, byte-scans live and backed-up durable data for exact private values, then proves cleanup, restart, hashed backup, restore, and a second boot;
- each Cloudflare live-agent proof requires credentialed generation and multi-turn continuity inside the sandbox; a deterministic ACP fixture, image version check, health response, or lifecycle-only test is not accepted as equivalent evidence, and exact model identity is not claimed without attestation;
- pinned OTel SDK/exporter packages initialize and export under Bun.

Before claiming Project collaboration, one clean revision must additionally prove the complete two-person path in `docs/project-collaboration.md`: distinct Actor credentials, same-Project visibility, delegator attribution, safe conversation/artifact detail, append-only comments and mentions, raw-API denial of another Actor's lifecycle commands, same-owner non-member isolation, cross-owner isolation, stream revocation after member removal, key rotation, restart, backup, and restore. A Project field, multiple owner keys, mock UI, or two browser windows is not equivalent evidence.

Assert ordering, error codes, and side effects with injected clocks and deterministic adapters. Do not sleep and hope. A mock proves replaceability; only the gated live test proves real provider integration.

## 15. Product surface and operating contract

Canonical commands:

```text
bun install
bun run dev
bun run typecheck
bun test
bun run check
bun run demo
bun run demo:serve
bun run proof:release
bun run proof:release:cloudflare
bun run proof:release:cloudflare:codex
bun run proof:release:cloudflare:claude
bun run proof:release:cloudflare:pi
bun run proof:verify -- <receipt> --require-clean --commit=<sha>
bun run doctor
bun run runner:build
bun run cli -- sessions create --agent <name> --provider <name> --files <dir>
bun run cli -- sessions send <session-id> --conflict reject -- <prompt>
bun run cli -- sessions watch <session-id> --json
bun run cli -- sessions close <session-id>
bun run cli -- data backup --output <dir>
bun run cli -- data verify <dir>
bun run cli -- data restore <dir>
bun run cli -- data gc --dry-run
bun run cloudflare:check
bun run cloudflare:dev
bun run cloudflare:deploy
docker compose up --build
```

`meanwhile doctor` validates environment configuration, database writability and exact schema identity, registered providers and deploy targets, runner and agent executables, agent catalog, and Cloudflare bridge health when configured, without revealing credentials.

`bun.lock` is generated by the first real install; never hand-create an empty lockfile. The runner builds as a standalone Bun executable and is copied outside provider workspaces.

README must let a new user complete the full local flow without reading source. It documents startup, schema initialization, tests, API/SDK/CLI examples, provider configuration, Cloudflare proof, run/log/cancel/artifact/deploy usage, session/turn/event/interrupt/close usage, data model, adapter and ACP boundaries, tenant and secret guarantees, timeout/idempotency/reconciliation/cleanup, local-provider non-isolation, production gaps, and an honest split between AI-assisted implementation and human design judgments.

`CHANGELOG.md` records user-visible behavior, API and protocol compatibility, schema replacement, and security-relevant changes. `SECURITY.md` defines disclosure and supported release policy; `CONTRIBUTING.md` defines the quality gate; `CODE_OF_CONDUCT.md` defines community participation. Keep them short and real rather than copying badges or ceremony the project does not yet support.

## 16. Implementation discipline

There is one architecture, not a disposable first version and a later “real” one. Modules may be unstarted; a completed module satisfies its final contract and tests. An empty file is more honest than a fake success path or TODO-shaped implementation.

Build in dependency order:

1. Bun/TypeScript/Biome, domain, errors, config, telemetry contract, current schema, store, control-plane lifecycle.
2. Runner protocol, ACP session, deterministic ACP fixture, standalone runner.
3. Provider/artifact/deploy contracts, fakes, registries, local implementations.
4. One-shot run service/executor, timeout, cancellation, reconciliation, cleanup, API.
5. Artifact capture and local deployment.
6. Cloudflare bridge and real remote provider.
7. CLI, doctor, demo, documentation, containers, complete verification.

The existing execution stack has completed that sequence. Forward product work now proceeds only through the ordered gates in `docs/project-collaboration.md`: durable Actor/Project membership; Project-bound work and derived-resource authorization; shared Project watch; append-only collaboration; two-person product proof; then Project-scoped shared execution intelligence and external integrations. Do not begin a later gate because an earlier schema or UI compiles.

For every change:

- keep the surface small and ownership complete;
- fail fast on invalid configuration and impossible state;
- fix causes, not symptoms hidden by retries, defaults, broad catches, or flags;
- never erase a boundary with `any`, shell interpolation, or unvalidated JSON;
- never log and continue after an invariant violation;
- keep one source for every configuration decision;
- update this file and adjacent docs when a controlling path changes;
- preserve unrelated work and prove the narrow change before the full gate.

## 17. Explicit limits and evolution triggers

Honest current limits:

- local execution is not isolation;
- API keys currently authenticate only an owner and all keys under that owner have owner-wide authority;
- the Board is a single-owner reference surface, not a shared multi-person Project;
- Project identity, Actor identity, memberships, delegator attribution, comments, mentions, and project-scoped authorization are not implemented;
- SQLite supports one active control-plane writer;
- in-flight recovery is only as strong as provider process identity and replay;
- mediated credentials do not make an allowed destination trustworthy or prevent workspace-data exfiltration to it;
- Cloudflare requires a configured account and deployed bridge;
- local-static is the only no-account deploy target required;
- idle session timeout closes continuity; provider-neutral suspend/resume is not implemented;
- session permission events are evidence only until a versioned permission-response command and explicit approval policy are implemented.

Change the correct boundary when evidence demands it:

- interactive approval requires an explicit permission-response command and policy on the existing runner command channel;
- horizontal scale requires shared leases and a multi-writer database;
- very large logs require a durable log-object/index boundary;
- stronger local isolation requires a container/VM provider;
- a new harness belongs behind ACP or an ACP adapter;
- a new cloud implements `RuntimeProvider` and passes the same contract suite;
- a new deployment target implements `DeployAdapter` over immutable input.

Never solve these by leaking cases into routes or `run-executor.ts`.

## 18. Current status

- The Bun control plane, exact SQLite schema/store and data-root lifecycle, one-shot and multi-turn ACP runner, durable run/session event journals, local and Cloudflare runtime adapters, immutable artifact pipeline, local-static deployment, complete owner-facing API/SDK/CLI resources, telemetry, reconciliation, cleanup, containers, and documentation are implemented.
- Durable sessions keep one ACP identity across ordered turns, explicit conflict policies, interrupt and per-turn timeout, process replay, control-plane restart, exact evidence deduplication, and independent runtime-lease cleanup. The deterministic suite owns interrupt/timeout semantics; current Cloudflare release evidence owns remote continuity, replay, restart, and cleanup rather than inheriting stronger claims from mock coverage.
- The no-account demo proves create → ACP run → durable logs/status → SDK artifact download → SDK deployment → isolated preview. The release proof binds exact agent output to the revision, promotes that output into an explicit Brief, proves a separate run can carry the frozen evidence into new immutable output, verifies the downloaded bytes and deployed URL, validates telemetry semantics and private-data exclusion, then extends the path through runtime destruction, restart, persisted reads, complete backup, restore, and a second boot.
- The deterministic suite covers product behavior, contracts, local composition, persistence, cancellation, timeout, restart reconciliation, secret boundaries, and provider replacement.
- The local proof is deliberately credential-free and deterministic. Credential-bearing Codex, Claude Code, and Pi proofs run only through the Cloudflare mediation boundary; local execution has no exception path.
- The Cloudflare package uses the real official Sandbox SDK and a pinned `standard-1` custom image containing the standalone Bun runner plus exact Codex, Claude Code, and Pi ACP toolchains. The image gate proves installation and bootability. Each separate credential-gated acceptance command requires remote output and two-turn continuity, then uses the public SDK to download, deploy, and fetch immutable output while verifying telemetry, persistence, backup/restore, and cleanup; only its clean current-revision receipt establishes that path as passed.
- Version `0.1.3` is the current published release baseline. Its Board proves one owner's read/delegate/detail loop, not multi-person Project collaboration.
- The branch also contains unreleased owner-scoped Brief reuse across one-shot Runs and turn-scoped Sessions with workspace relevance and dispatch-time byte revalidation. That work remains a valid supporting capability, but Fact discovery and further intelligence work are paused behind the Project collaboration gates.
- The active milestone is Gate 1 of `docs/project-collaboration.md`: durable Actor identity, Project, membership, and credential binding. This branch carries one current data and execution contract with no alternate path; current evolution limits are recorded in Section 17 and README.

Keep this section factual. Never describe an interface, mock-only path, local container proof, or skipped account test as stronger evidence than it is.
