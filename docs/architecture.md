# Architecture

This document explains Meanwhile's implemented durable architecture. [AGENTS.md](../AGENTS.md) is normative when wording differs. Meanwhile is pre-release; implementation claims are established by the matching contract, behavior, integration, demo, container, or live-provider proof.

## The system property

Meanwhile must answer four questions after any ordinary failure:

1. What did the owner ask to happen?
2. What actually happened in the runtime?
3. Which result is authoritative?
4. What disposable resources still need cleanup?

That property determines the architecture. The control plane owns durable intent and policy. Adapters execute provider-specific operations and report facts. The runner owns the live ACP conversation. No lower layer decides control-plane state.

## Topology

```text
SDK / CLI / upstream agent
          │ bearer auth · HTTP / SSE
          ▼
┌──────────────────────────────────────────────────────┐
│ control plane                                        │
│ API · auth · services · state machine · reconciliation│
│ SQLite metadata · audit · artifacts · telemetry      │
└───────────────┬───────────────────┬──────────────────┘
                │                   │ immutable source
       RuntimeProvider         DeployAdapter
                │                   │
        ┌───────┴────────┐          └── local-static
        │                │
 local processes   Cloudflare bridge
        │                │ RPC
        └──── isolated runtime ─────┘
                    │
             meanwhile-runner
                    │ local stdio ACP
                    ▼
                 ACP agent
```

The Cloudflare bridge is independently deployable because it runs in a different platform runtime and owns provider translation. It is not a second control plane and stores no owner, run, artifact, or deployment policy.

## Four durable concepts

| Concept | Lifetime | Authority | Key rule |
| --- | --- | --- | --- |
| Run | Durable | Control-plane state machine | User intent and terminal result survive compute |
| Runtime | Disposable | Provider facts plus control-plane cleanup state | May disappear without deleting the run |
| Artifact | Durable and immutable | ArtifactStore bytes plus SQLite metadata | Identity is content-derived |
| Deployment | Durable | Deployment state machine | Promotes captured bytes, never a live workspace |

Collapsing any pair creates a correctness failure. Runtime deletion cannot imply run deletion. A successful agent exit cannot imply artifact capture succeeded. Deployment failure cannot rewrite the run. Cleanup failure cannot un-cancel a run.

## Ownership map

| Layer | Owns | Must never own |
| --- | --- | --- |
| Public client | Typed resources, request identity, structured errors, waits, SSE replay validation | Server composition, provider handles, SQL, policy |
| API | Authentication boundary, validation, serialization | SQL, provider orchestration, state mutation |
| Run service | Owner-scoped use cases | Provider-specific branches |
| Run executor | Claims, transitions, deadlines, cancellation, reconciliation | Public request parsing, SDK-specific types |
| Store | SQL, transactions, ordering, uniqueness, owner predicates | Provider calls, secret values, artifact bodies |
| Runtime provider | Compute, process, event, file, expose, health primitives | Owners, run status, audit policy, deployment |
| Runner session | Runner launch/reconnect and validated event ingestion | ACP implementation details |
| Runtime-local runner | ACP session, child process group, relative timeout budget, protocol frames | Durable status, auth, storage, deployment |
| Artifact collector/store | Safe capture and immutable bytes | Run outcome decisions |
| Deployment executor/adapter | Deployment state and target execution | Mutable runtime access, run mutation |
| Reaper | Eligible runtime destruction and cleanup evidence | Deleting durable product history |

The most important negative rule is simple: `run-executor.ts` never branches on a provider name. Provider choice is resolved by a registry; capability decisions use explicit provider-neutral facts.

The public contract has one implementation path. Pure Zod schemas define requests and responses, generate OpenAPI through the Hono route layer, and validate SDK traffic at runtime. `src/client.ts` adds the deep consumer semantics that raw HTTP should not force every caller to rebuild: authentication, request correlation, durable waits, structured safe failures, and cursor-correct `AsyncIterable` log following. The CLI and executable demos are presentation layers over that client. None may call a service or store directly, so local convenience cannot become a second control plane.

## Control path of a run

### 1. Accept

The API authenticates the bearer key, derives `ownerId`, validates the body, and passes a canonical request to `RunService`. It never accepts owner identity or opaque provider handles from the body.

Before the store transaction, the run service resolves the strict agent catalog entry into an immutable launch snapshot. The snapshot contains only non-secret executable, argv, capability, allowlist, and derived permission-policy data plus definition and catalog digests. It also captures a self-verifying execution identity: runner digest when known, provider adapter version, capability digest, pinned image reference/digest when known, and bridge protocol version. Both snapshots are part of the idempotency hash; later catalog, adapter, capability, runner, or image-configuration edits cannot silently change queued or recovering work.

Inline workspace files follow a prepare/publish boundary. Preparation snapshots every caller-owned buffer, validates the complete path/size set, and computes the canonical manifest and content digests without storage writes. The resulting bundle identity is part of the request hash, allowing the owner-scoped idempotency key to be checked before publication. Publication writes idempotent content-addressed blobs and commits the owner-scoped workspace-bundle catalog row; only then may the run transaction commit. An existing bundle reference is validated in the authenticated owner scope before run creation. The SQLite uniqueness constraint remains the concurrency authority; the single-control-plane keyed gate only avoids redundant upload work.

An interrupted multi-blob publication may leave unreferenced content-addressed bytes before its catalog commit. Those bytes are not an addressable workspace input. The explicit data-root garbage collector discovers them from the durable reference graph, reports a dry run first, and removes them only on a separate apply command; request handling never performs opportunistic deletion.

The store transaction:

1. reserves `(ownerId, idempotencyKey)` with a canonical request hash;
2. creates one `queued` run;
3. appends the initial status event;
4. appends `run.create` audit evidence.

Equal key and hash returns the same run. Equal key with different input is a conflict. A unique constraint, not an in-memory check, resolves concurrent duplicates.

### 2. Claim and provision

One executor claims the run with a compare-and-swap state/version predicate. The persisted absolute deadline starts at this claim, so provider provisioning is inside the timeout budget.

Before compute, the executor verifies that current provider/runner provenance still matches the accepted snapshot. A mismatch fails closed without a provider operation. The selected provider then creates and starts compute, receives safe workspace input, and spawns the fixed runner. Opaque runtime and process handles are persisted without inspecting provider-private fields.

### 3. Establish ACP

The control plane sends one validated `RunnerSpec` to the runner through initial stdin. It converts the remaining persisted deadline into a relative timeout budget immediately before spawn; no control-plane or sandbox wall-clock instant crosses the runner protocol. Resolved secret values are process environment only and are absent from the serialized specification.

The runner launches the snapshotted bare PATH executable and argv directly with `TZ=UTC`, initializes ACP, negotiates capabilities, creates a session, and begins the prompt turn. It enforces the relative budget with a monotonic clock. The provider runtime or image, not the control-plane host, owns executable availability. Only a successful ACP initialization and session creation permits the executor to transition the run to `running`.

Agent-specific parsing never enters this path. A non-ACP tool needs a separate ACP adapter executable.

### 4. Ingest evidence

Runner stdout contains versioned NDJSON frames only. Each has a monotonically increasing runner sequence. The provider wraps transport events in its own reconnect cursor. The runner session validates bounds and protocol version, deduplicates accepted runner sequences, redacts output, and appends durable log or lifecycle evidence.

Runner and provider timestamps remain diagnostic facts. Durable/public evidence receives its UTC timestamp when the control plane accepts it, preventing sandbox clock skew from corrupting ordering or user-facing history. Consumers render those instants in the user's timezone.

```text
provider cursor → transport resume
runner sequence → semantic deduplication
database sequence → public log polling and SSE
```

These cursors solve different problems and must not be conflated.

### 5. Finalize and capture

The executor interprets validated terminal evidence and process exit facts, then atomically claims one terminal state. A terminal run never transitions again.

Artifact capture is a separate operation. It collects only declared paths through the provider file contract, enforces bounds and path safety, scans for known secret values, hashes deterministic bytes, and stores them atomically. A failed agent can still produce useful artifacts. Capture failure is separate evidence unless an explicit product policy says otherwise.

### 6. Clean up

Terminalization makes the associated runtime eligible for durable cleanup. The reaper claims cleanup work, calls idempotent `destroy`, records safe failure evidence and bounded backoff when necessary, and audits the destruction attempt.

Cleanup never deletes the run, logs, status events, artifacts, deployments, or audit records. A runtime for a `running` run is never eligible.

## Run state machine

```text
queued ──► provisioning ──► running ──► succeeded
   │              │            ├──────► failed
   │              │            ├──────► cancelled
   │              │            └──────► timed_out
   │              ├───────────────────► failed | cancelled | timed_out
   └──────────────────────────────────► cancelled
```

Each accepted transition writes the run row, incremented status version, append-only status event, and required audit record in one transaction. Logs do not drive status. Provider inspection does not overwrite status. Terminal states are immutable.

## Races have explicit winners

### Cancellation versus exit

Cancellation persists intent before signalling. The executor uses a compare-and-swap terminal claim. Whichever valid terminal transition commits first is authoritative; later signals or exits become evidence and cleanup input, not a second outcome. Repeated cancellation is idempotent.

### Timeout versus success

The persisted absolute deadline is enforced by the control plane; the runner independently enforces the remaining duration with a monotonic clock. Either can initiate process termination, but only one database transition can claim `timed_out`. A success observed after that claim cannot replace it.

### Cleanup versus active execution

Cleanup eligibility is checked against authoritative run state in the claim transaction. The provider's apparent process state is insufficient to destroy a runtime for a `running` run.

### Duplicate execution

State versioning and compare-and-swap claims prevent two executors from owning the same transition. Idempotent provider stop/destroy operations make recovery safe when an operation committed remotely but its local acknowledgement was lost.

## Restart reconciliation

SQLite is the durable authority; the API process is replaceable.

On startup the control plane:

1. applies migrations before readiness;
2. resumes eligible queued work;
3. inspects non-terminal runtime/process handles;
4. replays provider events after persisted cursors;
5. deduplicates runner sequences;
6. reconnects active sessions or finalizes exited ones;
7. marks irrecoverable missing compute as `RUNTIME_LOST` after bounded reconciliation;
8. resumes pending cleanup and deployment work.

Recovery strength is a declared provider capability. Meanwhile does not fabricate recovery for a provider that cannot persist process identity or replay events.

## Deployment path

```text
owner request
    │ authorize run and requested logical source
    ▼
resolve captured source → immutable artifact ID + digest
    │ create deployment + audit
    ▼
DeployAdapter.publish(immutable bytes, validated target config + declared secrets)
    │ ordered logs + structured result
    ▼
validated canonical HTTP(S) URL or safe structured error
```

The adapter cannot read a live runtime, public owner identity, or database handle. This keeps deployment replayable after runtime destruction and makes promotion auditable.

## Persistence boundaries

SQLite stores relational truth: ownership, state, ordering, uniqueness, references, cleanup, and audit. It does not store artifact bodies or resolved secrets. WAL and a busy timeout improve one-writer operation; they do not make SQLite a distributed lease service.

Artifact bytes are owner-scoped and content-addressed. Atomic writes publish only complete objects. Artifact metadata binds each object to an owner and run, logical path, digest, media type, size, and storage key.

One active control-plane writer is an explicit topology constraint. An adjacent data-root lease excludes a second service process and maintenance commands. Horizontal writers require a shared lease-capable database and are an evolution trigger, not a hidden promise.

The data root is one recovery unit. Backup requires quiescent durable work, serializes a standalone SQLite snapshot, walks the complete referenced workspace/artifact graph, includes persisted preview bytes, and hashes every file into an atomic manifest outside the live root. Verification reopens the database read-only and checks migrations, graph completeness, paths, sizes, and digests. Restore accepts only an absent or empty root. Garbage collection derives reachability from SQLite and is explicit dry-run/apply work.

## Complete public resource boundary

Runs are the orchestration resource, but not the only durable product resource. The same owner-scoped HTTP/client/CLI boundary exposes artifact inspection and byte streaming, deployment history and logs, append-only audit queries, and API-key create/list/revoke. This keeps operators and upstream agents out of SQLite and local storage. Maintenance is the only intentional local-only CLI surface because it requires exclusive ownership of the data root rather than bearer authorization.

The release proof exercises this boundary as a system property: a revision-bound prompt and structurally verified ACP response, agent-written artifact, deployment and preview, semantic OTLP traces/metrics with private-input exclusion, destruction audit, restart, persisted reads, hashed backup, restore, and a second boot. The credential-gated Cloudflare variant runs the same control path against real isolated compute; the provider lifecycle test remains a narrower adapter proof.

## Evidence planes

| Plane | Audience | Durable | Contains |
| --- | --- | --- | --- |
| Run logs | Owner | Yes | Redacted ACP updates, agent stderr, lifecycle messages |
| Operational telemetry | Operator | Export-dependent | Structured service logs, manual traces, bounded metrics, diagnostics |
| Audit | Owner/operator policy | Yes, append-only | Actor, action, resource, request/trace IDs, safe mutation metadata |

The planes may correlate by stable identifiers but never substitute for one another. Audit is not debug output. Provider diagnostics are not user run logs. Logs do not determine state.

## Extension rules

- New runtime: implement `RuntimeProvider`, declare truthful capabilities, and pass the shared contract suite plus a live proof.
- New agent: add a validated catalog entry if it speaks ACP; otherwise build an ACP adapter executable.
- New deployment target: implement `DeployAdapter` over immutable bytes and pass the deployment contract.
- New artifact backend: implement the atomic immutable owner-scoped `ArtifactStore` contract.
- Interactive approval: add a deliberate bidirectional runner control protocol; do not tunnel improvised stdin through provider commands.
- Horizontal control plane: replace the store boundary with a lease-capable shared database; do not scatter locks through services.

No extension adds a provider or agent switch to routes or the run executor.

## Deliberate constraints

Meanwhile chooses a small, deep control plane over a generic workflow platform:

- Bun owns runtime, package, process, test, and local SQLite responsibilities.
- Hono and Zod own the HTTP boundary without a Node server compatibility layer.
- ACP owns harness neutrality; Meanwhile does not parse every coding CLI.
- SQLite is honest about a one-writer topology.
- There is one real remote provider, not several shallow adapters.
- Manual OpenTelemetry instrumentation covers ownership boundaries rather than every function.

The result should remain understandable as a complete system. Complexity is accepted only where it buys a named product property: isolation, durability, replay, cancellation, authorization, immutable promotion, or explainable failure.
