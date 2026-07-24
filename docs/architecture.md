# Architecture

This document explains Meanwhile's implemented durable architecture. [AGENTS.md](../AGENTS.md) is normative when wording differs. Implementation claims are established by the matching contract, behavior, integration, demo, container, or live-provider proof.

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
│ run/session intent · auth · policy · reconciliation   │
│ SQLite metadata · audit · artifacts · telemetry      │
└───────────────┬───────────────────┬──────────────────┘
                │                   │ immutable source
       RuntimeProvider         DeployAdapter
                │                   │
        ┌───────┴────────┐          └── local-static
        │                │
 local processes   Cloudflare bridge
        │                │ authenticated HTTP
        └──── isolated runtime ─────┘
                    │
             meanwhile-runner
                    │ local stdio ACP
                    ▼
                 ACP agent
```

The public boundary offers two execution shapes over that same data plane:

```text
one-shot Run ───────────────► immutable Artifact ─► Deployment

durable AgentSession ─► Turn 1 ─► Turn 2 ─► …
             └────────► RuntimeLease ─► ordered runner commands
```

The Cloudflare bridge is independently deployable because it runs in a different platform runtime and owns provider translation. It is not a second control plane and stores no owner, run, artifact, or deployment policy. Its narrow Durable Object registry owns only provider-side lifecycle evidence: exact runtime/process admission, immutable terminal process snapshots, input sequence bindings, and encrypted credential leases. This lets an exited SDK process be recovered through matching exit-code closure frames in retained logs without promoting provider state to run authority or re-running the agent.

## Four durable concepts

| Concept | Lifetime | Authority | Key rule |
| --- | --- | --- | --- |
| Run | Durable | Control-plane state machine | User intent and terminal result survive compute |
| Runtime | Disposable | Provider facts plus control-plane cleanup state | May disappear without deleting the run |
| Artifact | Durable and immutable | ArtifactStore bytes plus SQLite metadata | Identity is content-derived |
| Deployment | Durable | Deployment state machine | Promotes captured bytes, never a live workspace |

Collapsing any pair creates a correctness failure. Runtime deletion cannot imply run deletion. A successful agent exit cannot imply artifact capture succeeded. Deployment failure cannot rewrite the run. Cleanup failure cannot un-cancel a run.

Interactive work adds `AgentSession`, `Turn`, `RuntimeLease`, and `SessionEvent`. They do not replace the four concepts above: a session owns ACP continuity, a turn owns one prompt outcome, a lease owns disposable compute cleanup, and the event journal owns replayable cross-turn evidence. A run remains the artifact-promotion boundary.

## Ownership map

| Layer | Owns | Must never own |
| --- | --- | --- |
| Public client | Typed resources, request identity, structured errors, waits, SSE replay validation | Server composition, provider handles, SQL, policy |
| API | Authentication boundary, validation, serialization | SQL, provider orchestration, state mutation |
| Run service | Owner-scoped use cases | Provider-specific branches |
| Run executor | Claims, transitions, deadlines, cancellation, reconciliation | Public request parsing, SDK-specific types |
| Session service | Owner-scoped session, turn, interrupt, and close commands | Provider operations, mutable status |
| Session executor | Session/turn claims, deadlines, command dispatch, replay, continuity, cleanup | Public request parsing, provider-name branches |
| Store | SQL, transactions, ordering, uniqueness, owner predicates | Provider calls, secret values, artifact bodies |
| Runtime provider | Compute, process, event, ordered input, file, expose, health primitives | Owners, run/session status, audit policy, deployment |
| Credential broker | Exact agent egress policy, opaque placeholders, trusted substitution, revocation | Compute, owner authorization, run/session status |
| Runner session | Runner launch/reconnect and validated event ingestion | ACP implementation details |
| Runtime-local runner | ACP session, child process group, relative timeout budget, protocol frames | Durable status, auth, storage, deployment |
| Artifact collector/store | Safe capture and immutable bytes | Run outcome decisions |
| Deployment executor/adapter | Deployment state and target execution | Mutable runtime access, run mutation |
| Credential/runtime reapers | Credential revocation, eligible runtime destruction, cleanup evidence | Deleting durable product history |

The most important negative rule is simple: neither executor branches on a provider name. Provider choice is resolved by a registry; capability decisions use explicit provider-neutral facts.

## Project collaboration boundary

Authentication resolves an API key or opaque browser session to one stable
`Principal` inside a hard `Owner` tenant. Projects never cross Owners. Active
`ProjectMembership` authorizes reading the Project's Runs, AgentSessions,
conversations, artifacts, Briefs, and deployments. Every Run and AgentSession
has an immutable Project binding and a snapshotted delegating Principal.

Visibility does not grant operation. Existing Run and AgentSession lifecycle
commands, and deployment creation, require the original delegator even when a
Project maintainer can manage membership. Principal-scoped idempotency prevents
two members using the same client key from colliding. Inaccessible resources
return `NOT_FOUND`.

The Board is a deployment-neutral BFF over the public client. When external
identity is configured, its same-origin start/callback routes correlate the
browser transaction with a short-lived HttpOnly cookie, while the control plane
owns PKCE, sealed provider-bound state, exact redirect validation, code exchange,
identity linking, credential sealing, grant observation, and browser-session
issuance in one transaction. Login, link, and invitation callbacks are separate
route capabilities; link must reauthenticate the initiating Principal, while
invite state can be created only from a valid digest-backed, expiring,
single-use invitation to an already provisioned person Principal. Redemption,
identity binding, and browser-session issuance are atomic. Provider tokens never
enter browser storage. A login identity must already map to a stable Principal;
the invitation path is the explicit first-visit identity-binding bridge. A
pending invitation takes precedence over an existing Board session until the
viewer explicitly keeps that session or completes provider authorization; the
two Principal identities are never merged. The Board then completes connected
onboarding and composes an authorized Project Lobby from public
Project, member, work, Relay, repository-binding, and PresenceLease reads,
then opens Project Watch for one selected Project. Lobby counts are projections,
not a second journal. Online people are deduped from unexpired
`(owner, project, principal, client)` leases; durable membership is never
presented as online presence. In team mode the Board
exchanges a person's API key once for a revocable, expiring control-plane
browser session, stores only that opaque secret in an HttpOnly SameSite cookie,
and uses it for deny-by-default Project requests. Exact same-origin Board writes
may create a Run as the authenticated Principal, cancel only a Run whose
delegator is that Principal, update that Principal's onboarding selection and
agent connections, heartbeat/release that client's presence, or perform the
Task Relay and Annotation operations from ADRs 0006 and 0009.
The authoritative Project work list is conditionally polled; task detail reads
the native Run or Session event journal. There is no second task table or
Project activity truth source. See
[Shared Project definition](project-collaboration.md) and the Project ADRs.

ADR 0007 adds a provider-neutral `RepositoryProjectDirectory` beside, not
inside, Project authorization. The GitHub implementation consumes a transient
GitHub App user token, lists only the installations and repositories GitHub
returns for that user/App intersection, normalizes the result to
watch/participate/administer, and returns no credential. The wired Lobby uses
selected existing Projects and groups explicit repository bindings by provider
account. External identity, repository binding, expiring grant, AgentConnection,
Project-selection persistence, OAuth/PKCE, sealed identity credentials, and
opaque browser-session issuance are implemented. GitHub checkout authority is
resolved only for the exact active Project/repository binding and is revalidated
against the current App/user repository intersection immediately before
workspace preparation. The access token is passed only to the bounded git
helper, its output is exact-value redacted, and the material is released before
the agent starts. Expired credentials fail closed and require relinking;
provider rejection or a missing repository revokes the local binding. Webhooks
remain an invalidation accelerator to add after live-provider acceptance, not a
correctness dependency. Owner continues to partition every resource request;
provider discovery cannot issue cross-Owner SQL.

The public contract has one implementation path. Pure Zod schemas define requests and responses, generate OpenAPI through the Hono route layer, and validate SDK traffic at runtime. `src/client.ts` adds the deep consumer semantics that raw HTTP should not force every caller to rebuild: authentication, request correlation, durable waits, structured safe failures, and cursor-correct `AsyncIterable` event following. `src/timeline.ts` is a pure projection from durable events to messages, tool calls, plans, usage, and statuses. The CLI and executable demos are presentation layers over that client. None may call a service or store directly, so local convenience cannot become a second control plane.

## Control path of a run

### 1. Accept

The API authenticates the bearer key, derives `ownerId`, validates the body, and passes a canonical request to `RunService`. It never accepts owner identity or opaque provider handles from the body.

Before the store transaction, the run service resolves the strict agent catalog entry into an immutable launch snapshot. The snapshot contains only non-secret executable, argv, capability, allowlist, and derived permission-policy data plus definition and catalog digests. It also captures a self-verifying execution identity: runner digest when known, provider adapter version, capability digest, pinned image reference/digest when known, and bridge protocol version. Both snapshots are part of the idempotency hash; later catalog, adapter, capability, runner, or image-configuration edits cannot silently change queued or recovering work.

Inline workspace files follow a prepare/publish boundary. Preparation snapshots every caller-owned buffer, validates the complete path/size set, and computes the canonical manifest and content digests without storage writes. The resulting bundle identity is part of the request hash, allowing the Principal-scoped idempotency key to be checked before publication. Publication writes idempotent content-addressed blobs and commits the owner-scoped workspace-bundle catalog row; only then may the run transaction commit. An existing bundle reference is validated in the authenticated owner scope before run creation. The SQLite uniqueness constraint remains the concurrency authority; the single-control-plane keyed gate only avoids redundant upload work.

`Brief` is the first shared-execution-intelligence resource. It is an immutable, owner-curated reference to one bounded UTF-8 text or JSON entry in an earlier run artifact. Promotion authorizes and validates the exact entry, exposes a human title plus its source identity and credential-free workspace basis, and copies no bytes. A new run or turn accepts only ordered `briefIds`; `BriefService` resolves them under the authenticated owner and `ExecutionContext` snapshots source run, source-workspace basis, artifact, entry path, digest, media type, and byte size into the resource's durable intent and idempotency hash. There is no second memory database: artifact bytes remain authoritative, and no evidence is mined, ranked, or attached implicitly.

An interrupted multi-blob publication may leave unreferenced content-addressed bytes before its catalog commit. Those bytes are not an addressable workspace input. The explicit data-root garbage collector discovers them from the durable reference graph, reports a dry run first, and removes them only on a separate apply command; request handling never performs opportunistic deletion.

The store transaction:

1. reserves `(ownerId, principalId, idempotencyKey)` with a canonical request hash;
2. creates one `queued` run;
3. appends the initial status event;
4. appends `run.create` audit evidence.

Equal key and hash returns the same run. Equal key with different input is a conflict. A unique constraint, not an in-memory check, resolves concurrent duplicates.

### 2. Claim and provision

One executor calls the store's dedicated `claimRunProvisioning` compare-and-swap. The transaction commits `queued → provisioning`, the absolute deadline, status evidence, audit, and system log together, so provider provisioning is inside the timeout budget.

Before compute, the executor verifies that current provider/runner provenance still matches the accepted snapshot. A mismatch fails closed without a provider operation. It then atomically records a stable runtime identity in a durable provisioning intent before calling the provider. `RuntimeProvider.create` is idempotent for that identity: if allocation succeeds but the process dies before the returned handle is persisted, restart reconciliation reacquires the same logical runtime, materializes its opaque handle, and either resumes active work or destroys it for terminal work. The provider then starts compute and receives safe workspace input. Core code never inspects provider-private handle fields.

For a repository-backed Run or AgentSession without an explicit credential reference, the executor may first resolve one exact Project-bound checkout credential. `WorkspacePreparer` uses it only as a Git HTTP header for init/fetch/checkout, never serializes it into durable intent, and the resolver releases it in a `finally` boundary before the runner starts. Before those control-plane-authored Git commands, the executor resolves referenced agent credentials in the control plane and attaches one durable `RuntimeCredentialBroker` lease whose exact-host policy is the union of the validated repository hostname and the snapshotted agent grants. Repository content and agent code do not execute during setup, agent values remain outside the sandbox, and the setup process receives no agent placeholders. The same lease then governs agent execution; recovery must reproduce the identical policy. A mediating provider denies every other destination, substitutes values only inside its trusted boundary, returns only opaque placeholders, and stream-redacts exact values from authorized upstream responses. Providers without this boundary reject secret-bearing agent admission. Setup credentials and deployment credentials remain separate operations and never inherit agent credentials.

Immediately before one-shot runner spawn, the executor persists a run-process launch intent containing stable runtime/process identities and the accepted remaining timeout budget, but no secret values. This freezes the full process specification across a control-plane crash: an exact `spawn` retry reacquires the same provider process instead of recomputing a different relative timeout and conflicting with it. Process handle, public run process identity, and start audit then materialize in one transaction.

### 3. Establish ACP

The control plane sends one validated `RunnerSpec` to the runner through initial stdin. It converts the remaining persisted deadline into a relative timeout budget immediately before spawn; no control-plane or sandbox wall-clock instant crosses the runner protocol. If context artifacts were accepted, it first re-reads them through the owner-scoped artifact service and verifies every field against the durable snapshot. It then compares each frozen source-workspace basis with the prepared current workspace and actual resolved commit through the pure `workspace-basis` module. The resulting `exact`, `same_repository_changed`, `same_repository_unresolved`, `different_workspace`, or legacy `unknown` relationship enters a versioned, delimiter-safe evidence envelope with both bases and the content. The envelope labels earlier agent output as untrusted observation that must be checked against the current workspace and explicitly states that relationship metadata is not truth certification. Real agent credential values never enter the runner or sandbox; the process environment contains only revocable broker placeholders, and even their names remain outside the serialized specification.

The runner launches the snapshotted bare PATH executable and argv directly with `TZ=UTC`, initializes ACP, negotiates capabilities, creates a session, and begins the prompt turn. It enforces the relative budget with a monotonic clock. The provider runtime or image, not the control-plane host, owns executable availability. Only atomic acceptance of the validated `session.started` frame transitions the run to `running`; no restart-time log scan can synthesize that transition.

Durable AgentSessions use the same workspace-basis semantics. Preparation persists the resolved repository commit on the session. Each Turn independently freezes ordered context snapshots in its idempotent intent. Immediately before the corresponding `turn.start` process input, `SessionExecutor` re-reads and revalidates those entries and renders the same envelope against the session's prepared workspace. The enriched prompt is deterministic for exact process-input retry, but the Brief selection does not become a session-global attachment or silently enter later turns.

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

The store also appends one contiguous `RunEvent` journal across status changes, validated runner frames, logs, artifact capture, and cleanup. That journal is the canonical material for a product timeline; the run-log table remains a focused resource view rather than the only observable truth.

### 5. Reserve, capture, and finalize

Atomic acceptance of a validated runner terminal frame first reserves that exact runner result together with its immutable log. This is the runner side of outcome arbitration: once reserved, cancellation, timeout, and control-plane failure cannot replace it. If another terminal status already committed, the frame is stored as `terminal.late` and reserves nothing. No recovery path derives a reservation from log text.

The executor then captures declared artifacts while the disposable runtime is still available. Capture uses abortable provider observations, remains bounded by the run's original absolute deadline, enforces bounds and path safety, scans for both resolved values and capability placeholders, hashes deterministic bytes, and stores them atomically. Recovery never restarts a non-running runtime solely to capture output. Deadline expiry records `ARTIFACT_CAPTURE_TIMED_OUT` and finalizes the reserved runner result without artifacts. A failed agent can still produce useful artifacts. Capture failure is separate evidence unless an explicit product policy says otherwise.

After the capture attempt, `claimRunOutcome` is the single public terminal-status commit. Its transaction verifies the exact reservation and commits status/version, status event, audit, terminal system log, and runtime cleanup eligibility together. Restart recovery resumes this finalization from the reservation. A terminal run never transitions again.

### 6. Clean up

Terminalization atomically schedules both credential revocation and eventual runtime cleanup. The credential reaper reacquires the exact lease identity, clears outbound policy, removes encrypted value material, and records bounded retry/audit evidence. Runtime destruction remains ineligible until that lease is durably `revoked`. The runtime reaper then reconciles interrupted provisioning intents, including the crash window where remote allocation succeeded before handle persistence, claims cleanup work, calls idempotent `destroy`, records safe failure evidence and bounded backoff when necessary, and audits each attempt.

Cleanup never deletes the run, logs, status events, artifacts, deployments, or audit records. A runtime for a `running` run is never eligible. A terminal runtime lacking its cleanup schedule is rejected as corrupt state rather than silently repaired.

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

## Control path of an interactive session

Session creation accepts the same immutable workspace input and snapshots the same agent definition, provider capabilities, and execution provenance as a run. It commits a `queued` `AgentSession`, Principal-scoped idempotency binding, initial event, and audit record before provisioning starts.

The session executor requires `processInput`, creates a runtime lease, starts a `SessionRunnerSpec`, and waits for `session.ready` before entering `idle`. The runner initializes one ACP child and one ACP session. It then observes positively sequenced commands from a provider-private mailbox:

```text
control-plane command sequence
        │ durable dispatch identity
        ▼
RuntimeProvider.send(process, command)
        │ ordered/idempotent mailbox
        ▼
meanwhile-runner ── local ACP prompt/cancel ── ACP agent
        │ session/turn frames
        ▼
provider cursor ──► runner sequence ──► durable session-event sequence
```

ACP never crosses the provider boundary. An exact command retry is harmless; reuse of one sequence for different input fails closed. A validated runner frame is accepted once, checked for exact replay, and atomically projected into session/turn state plus one contiguous `SessionEvent` stream.

Each turn owns an absolute control-plane deadline and receives only the remaining duration. `reject`, `enqueue`, and `interrupt_and_send` are explicit durable conflict policies. Interrupt and timeout terminalize one turn while preserving the ACP session. Closing is idempotent, terminalizes unfinished turns, and schedules runtime-lease cleanup independently from session history.

The session runtime lease is also the durable process-launch boundary. Materializing a spawned session runner commits its opaque process handle, the session's public process identity, and the `agent.start` audit in one transaction. Exact retry is idempotent; a partial or conflicting identity is a persisted-integrity failure, never a state to repair heuristically.

On restart, a capable provider reconnects the same process, replays after the persisted cursor, and resumes undispatched commands. A missing or unrecoverable process becomes `continuity_lost`; Meanwhile never substitutes a fresh ACP context while claiming continuity.

## Races have explicit winners

### Cancellation versus exit

Cancellation, timeout, and control-plane failure compete with the runner's atomic terminal-frame reservation. A successful cancellation transaction commits public status, request/result audit, and cleanup eligibility before any signal is sent. A runner reservation that commits first must later finalize that exact result; a runner frame that arrives after another public terminal commit is diagnostic-only. Repeated cancellation is idempotent.

### Timeout versus success

The persisted absolute deadline is enforced by the control plane; the runner independently enforces the remaining duration with a monotonic clock. Either can initiate process termination, but only one database transition can claim `timed_out`. A success observed after that claim cannot replace it.

### Cleanup versus active execution

Cleanup eligibility is checked against authoritative run state in the claim transaction. The provider's apparent process state is insufficient to destroy a runtime for a `running` run.

### Duplicate execution

State versioning and compare-and-swap claims prevent two executors from owning the same transition. Idempotent provider create/stop/destroy operations make recovery safe when an operation committed remotely but its local acknowledgement was lost.

## Restart reconciliation

SQLite is the durable authority; the API process is replaceable.

On startup the control plane:

1. initializes an empty database or verifies the exact current schema before readiness;
2. resumes eligible queued work;
3. recovers interrupted runtime-create and cleanup claims, reacquiring exact runtime identities when a handle was not durably materialized;
4. inspects non-terminal runtime/process handles;
5. replays provider events after persisted cursors;
6. deduplicates runner sequences;
7. reconnects one-shot runner sessions and durable agent sessions or finalizes exited ones;
8. marks irrecoverable missing compute as `RUNTIME_LOST` after bounded reconciliation;
9. resumes pending cleanup and deployment work.

Recovery strength is a declared provider capability. Meanwhile does not fabricate recovery for a provider that cannot persist process identity or replay events.

## Deployment path

```text
owner request
    │ authorize run and requested logical source
    ▼
resolve captured source → immutable artifact ID + digest
    │ canonical hash + Principal-scoped idempotency claim
    ▼
atomic deployment + create audit
    ▼
DeployAdapter.publish(immutable bytes, validated target config + declared secrets)
    │ ordered logs + structured result
    ▼
validated canonical HTTP(S) URL or safe structured error
```

HTTP admission requires an `Idempotency-Key` scoped to the authenticated owner. Its canonical hash binds the normalized source selector, target, caller configuration, and secret references. First admission resolves immutable bytes, then the binding, deployment row, immutable artifact reference, and create audit share one SQLite transaction. Exact retries return the original record before consulting mutable adapters or source catalogs; conflicting reuse fails before a second target identity exists.

The adapter cannot read a live runtime, public owner identity, or database handle. This keeps deployment replayable after runtime destruction and makes promotion auditable. The durable `running` state surrounds the external side effect: after target success becomes possible, a deployment-log or success-transaction write failure leaves the record recoverable rather than claiming false failure. Restart replays the idempotent adapter with the stable deployment ID and immutable source.

`local-static` uses one canonical publication manifest across adapter execution, restart reconciliation, backup, and restore. Reuse requires an exact graph match with no links, missing files, or extras and rehashes every published byte; matching manifest text without matching content is rejected.

## Persistence boundaries

SQLite stores relational truth: ownership, state, ordering, uniqueness, references, cleanup, and audit. It does not store artifact bodies or resolved secrets. WAL and a busy timeout improve one-writer operation; they do not make SQLite a distributed lease service.

Artifact bytes are owner-scoped and content-addressed. Atomic writes publish only complete objects. Artifact metadata binds each object to an owner and run, logical path, digest, media type, size, and storage key.

One active control-plane writer is an explicit topology constraint. An adjacent data-root lease excludes a second service process and maintenance commands. Horizontal writers require a shared lease-capable database and are an evolution trigger, not a hidden promise.

The data root is one recovery unit. Backup requires quiescent durable work, serializes a standalone SQLite snapshot, walks the complete referenced workspace/artifact graph, and derives the exact persisted-preview set from successful local deployment rows. It rejects orphan, extra, linked, missing, or content-mismatched publication files rather than legitimizing them in a backup. Verification reopens the database read-only and checks the exact schema identity, graph completeness, paths, sizes, and digests. Restore accepts only an absent or empty root. Garbage collection derives reachability from SQLite and is explicit dry-run/apply work.

## Complete public resource boundary

Runs and agent sessions are the two orchestration resources. The same HTTP/client/CLI boundary exposes run/session event replay, turn commands, artifact inspection and byte streaming, deployment history and logs, append-only audit queries, and API-key create/list/revoke. Owner is the hard tenant boundary; inside it, stable Principal identity and active Project membership authorize shared reads while the immutable original delegator retains lifecycle control. This keeps operators and upstream agents out of SQLite and local storage. Maintenance is the only intentional local-only CLI surface because it requires exclusive ownership of the data root rather than bearer authorization.

The release proof exercises this boundary as a system property: a revision-bound prompt and structurally verified ACP response, SDK download of immutable agent output, explicit promotion of one entry to a Brief, a separate run that freezes and revalidates that evidence into new immutable output, two turns on one ACP identity across control-plane restart, explicit `local-static` deployment and URL verification, semantic OTLP traces/metrics with private-input exclusion, destruction audit, persisted reads, hashed backup, restore, and a second boot. Release receipts distinguish three non-interchangeable classes: deterministic local control-plane evidence, deterministic ACP/provider compatibility on actual remote compute, and credentialed live-agent execution on actual remote compute. A live-agent receipt proves that the configured ACP toolchain created the deployed bytes, reused explicitly selected historical evidence, and preserved continuity; it does not attest the downstream model identity. The provider lifecycle test remains a narrower adapter and credential-mediation proof.

The receipt is a versioned canonical claim bound to the Git commit, worktree cleanliness, toolchain, configured runner/image provenance, semantic evidence, restored source-run/Brief-backed-run/session credential-lease revocation for live agents, and an internal digest. Version 2 adds the Brief-backed evidence chain; the verifier retains version 1 support so already-issued receipts remain independently checkable. Local commands retain receipts under ignored `.proof/` state for inspection. The explicit remote GitHub workflow verifies a receipt against the workflow revision, uploads it, and signs its artifact provenance. This makes “the gate exists,” “the image boots,” “the gate passed,” and “the exact clean revision has retained evidence” four distinct statements.

## Evidence planes

| Plane | Audience | Durable | Contains |
| --- | --- | --- | --- |
| Product evidence | Authorized Project member | Yes | Run logs plus run/session status, ACP updates, stderr, turn identity, artifact and cleanup events |
| Operational telemetry | Operator | Export-dependent | Structured service logs, manual traces, bounded metrics, diagnostics |
| Audit | Owner/operator policy | Yes, append-only | Actor, action, resource, request/trace IDs, safe mutation metadata |

The planes may correlate by stable identifiers but never substitute for one another. Audit is not debug output. Provider diagnostics are not user run logs. Logs do not determine state.

## Extension rules

- New runtime: implement `RuntimeProvider`, declare truthful capabilities, and pass the shared contract suite plus a live proof.
- New agent: add a validated catalog entry if it speaks ACP; otherwise build an ACP adapter executable.
- New deployment target: implement `DeployAdapter` over immutable bytes and pass the deployment contract.
- New artifact backend: implement the atomic immutable owner-scoped `ArtifactStore` contract.
- Interactive approval: add a versioned permission-response command and policy on the existing runner command channel; do not tunnel improvised stdin or remote ACP.
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
- Durable sessions reuse the same runner/provider/store boundaries instead of adding WebSockets, an in-memory actor, or a second workflow engine.

The result should remain understandable as a complete system. Complexity is accepted only where it buys a named product property: isolation, durability, replay, cancellation, authorization, immutable promotion, or explainable failure.
