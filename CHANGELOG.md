# Changelog

All user-visible, operator-visible, compatibility, schema, and security-relevant changes to Meanwhile are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The first shared-execution-intelligence loop for one-shot runs: `Brief` is an immutable, owner-curated reference to one bounded text or JSON entry in an earlier run artifact. Owners promote evidence and select ordered `briefIds`; admission freezes the exact source run/artifact/path/digest/media type/size into durable intent and idempotency, and runner launch revalidates those bytes before placing delimiter-escaped, untrusted historical evidence ahead of the current task. HTTP/OpenAPI, typed SDK, CLI (`briefs create|list|get`, `run --brief`), SQLite, restart, and local end-to-end paths share one contract. The Board adds the same explicit “keep output → attach prior brief” loop without gaining task-lifecycle mutation.
- Release-proof receipt v2 now makes that loop release evidence: it promotes the source artifact, executes and semantically verifies a separate Brief-backed run, proves its frozen context and runner-time revalidation, cleanup, credential revocation when brokered, restart persistence, backup, and restore. The verifier continues to validate already-issued v1 receipts.

### Changed

- The single current SQLite schema now persists immutable Brief metadata and accepted context-artifact snapshots on runs. As with every schema fingerprint change before an upgrade contract exists, operators must use a fresh data root. Existing durable data cannot be carried forward until a separate export/import contract exists; Meanwhile never attempts in-place migration.

### Pending release evidence

- The `remote-live-agent` path is not asserted for this revision. A `pi-acp@0.0.31` boundary maps an internal model/RPC `error` to ACP `end_turn`; the semantic proof rejects the resulting empty response and publishes no receipt, so the Pi live-agent path is not accepted until the adapter is corrected and a clean receipt succeeds. Credentialed Codex and Claude Code paths likewise require a clean `remote-live-agent` receipt on the released revision before they are claimed for it.

## [0.1.3] - 2026-07-18

Evidence scope: the board ships behind `local-control-plane` evidence — its read/delegate/history paths and its structural read-only boundary are verified end to end against a running local control plane (workspace test suite plus headless-browser walkthrough of the calm, alert, and delegate states). It introduces no new `remote-live-agent` claim. The board is distributed as an isolated workspace and is **not** part of the published `@kohoz/meanwhile` package; run it from a clone.

### Added

- A delegator's Waiting-For board (`board/` workspace): a web view for the people who *asked* for the work — teammates, leads, on-call — not the operator who launched it. It answers one question before you read anything — does anything need a human? — with a single verdict ("Nothing needs you" / "N tasks need your call"), rations color and weight to waiting/recovering work only, and opens any task to its agent conversation (live-followed or loaded from durable history for closed tasks). It can delegate new work (`POST /delegate` → `runs.create` / `sessions.create`) but never cancel, close, or mutate an existing task; read-only-for-existing / delegate-only-for-new is structural. It is a read-only consumer of the public client behind its own origin with defensive headers, so the bearer key never reaches the browser. Distributed as an isolated workspace (its React stack never enters the `@kohoz/meanwhile` package); run it from a clone with `bun run board:build && bun run board:dev`.

## [0.1.2] - 2026-07-18

Evidence scope: this release carries the durable control-plane, session, credential-broker, and packaging work below, each behind `local-control-plane` and deterministic `remote-provider-compatibility` proofs. It does **not** assert any `remote-live-agent` conclusion — those remain per-revision receipts, and the Pi path is known-open (see Unreleased).

### Added

- Published as the `@kohoz/meanwhile` package with a `meanwhile serve` command that starts the control plane on this host, so `bunx @kohoz/meanwhile serve` runs it without a clone. The standalone runner is compiled once on first start when the default runner path is absent, since the binary is neither committed nor publishable and dependency install scripts are blocked by default; a caller-provided runner path is never rebuilt.
- Owner-scoped request idempotency for deployment admission across HTTP/OpenAPI, SDK, CLI, service, and SQLite, with canonical immutable-intent hashing and atomic create audit evidence.
- A common resource-bound `SecretResolver` material contract with awaited local zeroization, without coupling executors to the bootstrap environment resolver or conflating observation cleanup with credential revocation.
- A provider-neutral `RuntimeCredentialBroker` boundary with durable per-run/session leases, opaque agent placeholders, exact host/method policy, restart-safe attachment, and bounded audited revocation before runtime destruction.
- Cloudflare live and release proofs now wait on bounded production-transport provider readiness, while idempotent lifecycle mutations absorb provider-classified container rollout transients without wall-clock readiness assumptions.
- Release-proof commands now rebuild their standalone runtime executables through one explicit execution entry, so a clean checkout cannot accidentally rely on stale or missing `dist/` state.
- Durable run/session runtime-provisioning intents and one-shot process-launch intents that close allocation/spawn-before-handle-persistence crash windows through exact-id provider reconciliation.
- Durable `AgentSession`, `Turn`, `RuntimeLease`, and `SessionEvent` resources across SQLite, HTTP/OpenAPI, the typed SDK, and CLI, preserving one ACP context across ordered prompts.
- Explicit turn conflict policies (`reject`, `enqueue`, `interrupt_and_send`), independent session/turn idempotency, per-turn deadlines, interruption without continuity loss, idempotent close, and durable session-runtime cleanup.
- One contiguous run event journal spanning status, validated runner evidence, logs, artifacts, and cleanup, with cursor pagination, resumable SSE, `meanwhile watch`, and pure presentation-neutral timeline reducers.
- Provider-neutral ordered/idempotent process input plus complete local mailbox execution and a versioned Cloudflare bridge mailbox backed by durable sequence/fingerprint reservation.
- Restart reconciliation for live interactive sessions, including provider/runner replay, exact evidence deduplication, undispatched command recovery, and explicit `continuity_lost` semantics.
- Session telemetry for durable queue/active/runtime/cleanup state and bounded turn outcomes, plus owner-isolation, secret-redaction, timeout, replay, cleanup, and restart tests.
- Exact Codex, Claude Code, and Pi ACP/runtime pairs in the Cloudflare compatibility image, with brokered remote release-proof commands.
- Versioned release-proof receipts with explicit local, remote-compatibility, and credentialed live-agent classes; canonical evidence digests; exact revision and dirty-state binding; restored run/session credential-lease revocation for live agents; atomic local retention; independent verification; and a manual real-account workflow that retains the receipt and signs its GitHub artifact provenance.

### Changed

- Run and deployment idempotency bindings now use explicit resource-specific relational tables with strong owner/resource foreign keys in the single current schema.
- Run state now has only three write paths: dedicated provisioning claim, atomic `session.started` acceptance, and one public terminal-status commit. Atomic runner-terminal reservation is kept distinct from status mutation so artifact capture and restart finalization remain explicit. The generic transition API, persisted cancellation flag, restart-time evidence repair, and unscheduled-cleanup repair path were removed.
- SQLite now has one current schema initialized atomically on an empty database and bound to an exact source fingerprint. Every foreign, partial, or differently fingerprinted database is rejected without upgrade, backfill, repair, or dual reads.
- Invalid provenance and deployment-log rows now fail as persisted-contract violations instead of entering alternate read fallbacks.
- Runner protocol v3 now supports both one-shot `RunnerSpec` and prompt-free `SessionRunnerSpec` modes with versioned turn, interrupt, and close commands.
- Cloudflare bridge protocol v6 combines capability-gated process input with encrypted credential leases, native exact-host egress policy, Worker-side HTTP substitution, streaming response redaction, and idempotent revocation without exposing SDK types to the control-plane core.
- Cloudflare runner staging now derives an explicit cross-compile Bun version from the root package manager, and the image gate verifies both embedded executables against it; the Sandbox base image is digest-pinned.
- Data-root quiescence and operational telemetry now include durable sessions and their independent runtime-lease cleanup lifecycle.
- Run and session admission are independently configurable; restart reconciliation always supervises already-live sessions, while session cleanup retains a separate bounded lane.
- Session and turn history use keyset/cursor pagination, turns have a direct read route, and the SDK provides direct turn waits, explicit session-status waits, and replay-safe retry across temporary API unavailability.
- API-key usage timestamps coalesce repeated authenticated reads into at most one durable write per minute.
- Release evidence no longer derives a `realModel` assertion from the selected agent. Receipts identify deterministic versus credentialed execution, name `local-static` as the deployment boundary, and record downstream model identity as unattested.

### Fixed

- Runtime-provider observation no longer erases the sibling credential-broker boundary: executors resolve compute and credential mediation independently from the provider registry, with a telemetry-enabled brokered-secret regression.
- Release-proof admission and preflight failures now emit the same structured error envelope as execution failures, while empty agent responses include only secret-safe event and payload-shape diagnostics instead of false success or an unstructured stack.
- The live Cloudflare credential-origin check now uses a status-validated echo response rather than assuming a third-party JSON body, so an upstream gateway failure remains structured evidence instead of a parser exception.
- The end-to-end timeout test now waits for durable `runtime.stop` evidence under a test-local budget that covers the product's five-second termination grace, instead of racing Bun's five-second default harness timeout under parallel load.
- Local POSIX process-group hard termination is now a single idempotent lifecycle operation, eliminating the macOS race where exit observation attempted a second group kill; process-tree tests synchronize on a validated ready PID instead of a 25 ms output assumption.
- Run terminal races now use an explicit two-phase runner path: terminal-frame acceptance atomically reserves the runner result before artifact capture, then the sole public terminal-status transaction commits status, events, audit, terminal log, and cleanup eligibility together. Cancellation, timeout, and control-plane failure lose to an existing reservation; late terminal frames remain diagnostic.
- Recovery now fails closed on the impossible split state of a terminal log without its atomic runner-session reservation instead of reconstructing lifecycle authority from logs.
- Interrupted run/session provisioning and cleanup claims are recovered on restart, including bounded reconciliation and destruction of compute that may have been allocated before its handle was persisted.
- One-shot runner spawn retries now reuse the durably accepted relative timeout budget, preventing restart-time budget drift from conflicting with an already-created provider process; process handle, run process identity, and audit materialize atomically.
- Session runner process handle, public process identity, and start audit now materialize in one exact, idempotent transaction; split or conflicting persisted identity fails closed.
- Runtime-start audit evidence is idempotently recovered from a proved running runtime, closing the session start-acknowledgement crash window without fabricating provider state.
- Artifact capture after runner-terminal reservation now remains bounded by the run's original absolute deadline; provider runtime/file observations are abortable, recovery never restarts compute solely for capture, timeout evidence is structured, and the reserved runner result still finalizes deterministically.
- Ambiguous deployment success now remains `running` for exact-id adapter reconciliation when durable logs or the success transaction fail, instead of permanently recording a false target failure.
- Local-static restart reuse and data-root backup now verify one canonical publication manifest, the exact referenced file graph, and every byte digest; orphan or tampered preview files are rejected rather than archived or reused.
- Local runtime destruction now waits for observed process exit publication before removing runtime state, eliminating a cleanup race with final exit metadata.
- Session command sequences are filename and persistence identities, preventing one sequence from being rebound to a different command ID.
- Timeline message identity now includes ACP role as well as turn and message ID, so an agent reusing one ID for thought and final output cannot collapse them.
- Cloudflare process admission and immutable terminal results now persist in the bridge registry. Matching stdout/stderr exit-code closure frames recover the same execution through retained SDK logs after its active process row disappears, preventing duplicate spawn and premature or lost terminal evidence.
- Cloudflare event replay drains once after terminal process observation, so a final log page published behind process state cannot be lost; stop snapshots no longer query a process API after the container is unavailable.
- Session terminal outcomes now use a declared counter instrument, keeping the failure path inside the fixed telemetry contract.
- The Cloudflare Codex wrapper retains its process-private authentication home through adapter exit and invokes the native pinned Codex executable directly.
- Third-party notice verification now rebuilds clean dependency roots and confines resolution to each declared graph, so cached, hoisted, or ancestor packages cannot make the release manifest depend on CI host state.

### Security

- Secret-bearing run/session admission now fails on providers without credential mediation. Cloudflare agent processes receive only revocable placeholders; real values remain encrypted in trusted bridge state and are substituted only for exact authorized destinations and methods under default-deny egress.
- Cloudflare installs deny-all outbound interception before container startup, so SDK-managed HTTPS certificate material is present even before a credential lease and exact-host handlers remain the only egress overrides.
- Local credentialed-agent commands were removed because the local provider is not a credential boundary; the deterministic no-account local demo remains the complete local path.
- Session prompts and resolved credentials stay out of process argv, runner specs, provider handles, telemetry, and durable evidence; the control plane retains an independent operation-scoped redactor through spawn/reconnect and redacts agent-controlled fields before SQLite accepts session output.
- Cloudflare reserves each process-input sequence against a secret-safe fingerprint before sandbox delivery; exact retries are harmless and conflicting reuse fails closed.
- Structured Codex login material is split into individually redacted secret values and reconstructed only inside the short-lived wrapper process instead of crossing the runner boundary as one opaque JSON credential.

## [0.1.1] - 2026-07-14

### Added

- A pinned Claude ACP toolchain in the Cloudflare custom image and `proof:release:cloudflare:claude`, which requires credentialed remote agent generation, public-SDK artifact download, public-SDK deployment, URL verification, telemetry, cleanup, restart, backup, restore, and second boot without claiming an attested downstream model identity.
- Matching custom-image reference support in execution provenance, configuration, release evidence, and documentation.

### Changed

- The supported Cloudflare live-agent image now uses `standard-1`; the smaller `lite` class remains unsuitable for the proven Claude ACP process set.
- The deterministic Cloudflare proof is explicitly classified as provider/control-plane compatibility evidence rather than credentialed live-agent acceptance.
- Agent working-directory policy now resolves explicitly to the provider workspace root instead of relying on an omitted runner default.

### Fixed

- Retryable Cloudflare transport operations now use one bounded, abortable retry boundary with stable request identity; event replay also preserves the same durable cursor without duplicating or skipping accepted output.
- Terminal Cloudflare processes now wait for bounded quiescence of the SDK's eventually consistent accumulated logs before the bridge publishes an exit cursor.
- Third-party notice verification now materializes the independent Cloudflare runtime-agent graph for its actual Linux/x64 target and includes installed optional platform dependencies.
- Cloudflare provenance no longer pairs the upstream Sandbox base-image tag with a digest belonging to the deployed custom image.

### Security

- Real-agent proof credentials remain reference-only in run intent, resolve only for the agent process, and are byte-scanned for absence across the live data root, backup, artifacts, deployment output, structured logs, and telemetry.

## [0.1.0] - 2026-07-14

### Added

- Bun/Hono/Zod control plane with generated OpenAPI, bearer-key authentication, owner-scoped run/deployment APIs, cursor polling, and resumable SSE logs.
- One exact SQLite schema and a single SQL store for runs, status events, idempotency, runtime cleanup, runner sessions, logs, immutable inputs, artifact metadata, deployments, and append-only audit evidence.
- Versioned runtime-local `meanwhile-runner` using the official ACP TypeScript SDK for capability negotiation, prompt turns, non-interactive permissions, cancellation, deadlines, bounded event frames, and exact-value redaction.
- Process-aware `RuntimeProvider` contract with opaque persistable handles, replay cursors, capabilities, safe errors, file operations, cancellation, lifecycle, health, and shared contract tests.
- Complete local provider using `Bun.spawn` and the same standalone runner as remote runtimes; local execution is explicitly diagnosed as non-isolating.
- Real Cloudflare Sandbox bridge package using the official pinned SDK and matching container image, authenticated/versioned bridge protocol, durable process identity, replayable events, safe file operations, port exposure, explicit destruction, and a credential-gated account test.
- Immutable content-addressed artifact storage, deterministic bounded collection, traversal/symlink defenses, and known-secret rejection.
- Agent-facing deployments over immutable sources, durable deployment state/logs/audit, restart reconciliation, and a no-account `local-static` adapter served from a defensive separate origin.
- Persisted provisioning-through-execution deadlines, cancellation intent, immutable terminal state, restart reconciliation, runner event deduplication, and durable cleanup with explicit bounded backoff.
- Structured JSON operational logs, manually bounded OpenTelemetry traces and metrics, correlation IDs, exporter health, and strict separation from product logs and audit records.
- CLI for runs, logs, cancellation, artifacts, deployments, provider diagnostics, key generation, and doctor checks; uploaded-directory support refuses links and enforces bounds.
- No-account executable demo proving ACP execution, durable evidence, artifact capture, API deployment, and HTTP preview.
- Bun container/Compose deployment, strict TypeScript/Biome configuration, CI quality gates, provider container checks, architecture/operations/provider/threat documentation, and open-source project policy files.
- Generated third-party production dependency notices, embedded project/license material in both distributed images, deterministic demo and image build CI proof, and an explicit fail-closed Cloudflare live-test command.
- Two-phase inline workspace admission that computes a canonical bundle identity before storage, validates existing bundles in the authenticated owner scope, and avoids candidate blob writes for idempotent replays and conflicts.
- Explicit `bun run demo:codex` live proof that uses locally authenticated Codex through an exact ACP adapter and compatible exact Codex runtime, then exercises the complete local API, evidence, artifact, deployment, and preview path without copying or persisting local authentication material.
- `bun run demo:codex:serve` inspection mode that keeps the verified Codex-generated local preview available until explicitly stopped.
- Exact `bun run demo:claude` and `demo:claude:serve` proofs through the official Claude Agent SDK ACP adapter, importing only allowlisted environment configuration from `~/.claude/settings.json` while keeping credential material ephemeral.
- Exact `bun run demo:pi` and `demo:pi:serve` proofs through the pinned Pi ACP adapter and headless RPC runtime, with an ephemeral allowlisted Amazon Bedrock authentication boundary and the same artifact, deployment, and preview acceptance path.
- Executable documentation contracts for local links, JSON examples, and the published agent-catalog template.
- Typed Web-standard client with resource namespaces, shared runtime-validated contracts, structured errors, deterministic terminal waits, response evidence, and replay-safe asynchronous log following.
- Bounded link-free Bun workspace capture as a separate client entrypoint and direct client contract coverage.
- Complete owner-scoped resource namespaces across HTTP, SDK, and CLI for artifact inspection/streaming download, deployment history, audit queries, and API-key create/list/revoke with final-key lockout protection.
- Immutable per-run execution provenance covering agent/catalog, runner, provider adapter/capabilities, runtime image evidence, and bridge protocol, with idempotency participation and fail-closed drift detection.
- Exclusive local data-root lease plus quiescent hashed backup/verification, staged restore, and explicit dry-run/apply reachability garbage collection.
- `bun run proof:release` system proof for a revision-bound ACP request and exact durable response, agent-produced artifact and preview, semantic OTLP signals and private-data exclusion, runtime destruction, restart, hashed backup, restore, and second boot; the Cloudflare variant runs the same proof with complete remote execution provenance.

### Changed

- The complete quality gate now builds the standalone runner and bundled demo agent before tests, so a clean checkout proves the same executables used by local and remote runtimes.
- Container CI now boots the packaged image and drives a complete SDK run, exact ACP response, agent-written artifact capture, deployment, and separate-origin preview flow instead of stopping at readiness.
- Agent launch configuration is now strict, portable, capability-derived, content-digested, and snapshotted into each run's durable idempotent intent; recovering runs no longer change behavior after catalog edits. The shipped catalog advertises only the bundled demo agent, with external ACP adapter entries supplied as documentation templates.
- Run creation may omit `provider`; the configured default is resolved and validated before any run or uploaded workspace state is persisted.
- Local preview URLs now use an explicit browser-facing origin whenever the server binds all interfaces, so deployment records never publish wildcard bind addresses.
- Source-checkout CLI examples use the executable `bun run cli --` path and `doctor` no longer performs an implicit runner build.
- Compose publishes only loopback host ports, makes its unsafe local-provider choice explicit, and accepts optional provider plus allowlisted `env://` values through an uncommitted runtime env file.
- Cloudflare bridge protocol v3 binds process retries to a secret-safe full-spec fingerprint, requires an explicit version header, preserves declared workspace file modes, keeps lifecycle truth in a separate durable registry, advertises only the SDK's hard-termination capability, and bounds accumulated replay to 4 MiB of UTF-8 output.
- CLI and executable demos now consume the same public client as external callers; public Zod contracts are separated from Hono registration, and hermetic demo-environment setup no longer obscures the SDK usage path.
- Runner protocol v2 carries a remaining timeout duration instead of a cross-machine wall-clock deadline; ACP children run in UTC, monotonic elapsed time owns runtime duration, and durable event timestamps come from control-plane acceptance.
- Successful local-static previews resume their separate listener after a control-plane restart.

### Fixed

- Packaged containers now place the data root beneath the writable `/data` volume, keeping its adjacent single-writer lease durable and writable for the non-root service user.
- Cloudflare workspace upload now applies and verifies immutable file modes, closing the uploaded-bundle path for executable agent and repository files.
- Local process recovery now reads Linux kernel process identity directly instead of requiring a `ps` utility that minimal production images do not contain.
- Sparse telemetry correlation is canonicalized before validation, preventing an unavailable optional identifier from obscuring the original failure.
- The production image now carries both versioned protocol modules required by the control-plane import graph, and CI boots the built image through `/readyz` instead of treating a successful image build as runtime proof.
- Doctor diagnostics now distinguish schema-identity mismatch from filesystem writability.
- Sandbox/provider timestamps can no longer control durable log chronology or runner timeout duration.
- Data-root maintenance now canonicalizes physical paths, preventing symlink aliases from bypassing writer exclusion or nesting a backup inside the live root; restore also revalidates each byte at publication time.
- Protected control-plane responses now default to `Cache-Control: private, no-store`, including one-time API-key material and authenticated errors.
- Artifact downloads now use an atomic no-clobber publication step, so a concurrent filesystem write cannot be overwritten after CLI preflight.

### Security

- Enforced owner predicates on public persistence lookups and returned `NOT_FOUND` for cross-owner resources.
- Stored bootstrap API keys only as SHA-256 digests of uniformly random 256-bit secrets with non-sensitive lookup prefixes.
- Kept prompts out of shell commands, launched agents by validated argv, restricted environment names through the agent catalog, and kept resolved values out of persisted runner specifications.
- Applied one redaction boundary to run/deployment logs, errors, audit metadata, telemetry, and artifact candidates, including values split across stream chunks.
- Added traversal, symlink-escape, host-path, mutable-deployment-source, preview-origin, provider-handle, and bridge-protocol defenses with adversarial tests.
- Documented the Cloudflare same-sandbox trust boundary, local-provider non-isolation, and exact-value redaction as defense in depth rather than an exfiltration boundary.
- Default tests never infer permission for remote Cloudflare mutation from ambient credentials; live account proof requires an explicit command and cannot silently skip missing credentials.
- Made process-environment secret references deny-by-default, bootstrap-owner scoped, target-bound, and permanently unable to address reserved control-plane/provider variables or repository checkout credentials.
- Gated admission to the non-isolating local runtime by API bind policy and an explicit unsafe acknowledgement while retaining the adapter internally for restart reconciliation and cleanup.
- Authorized a deployment's run before target or source resolution, constrained adapter secret inputs by declared environment targets, and rejected non-canonical, credential-bearing, control-bearing, oversized, non-HTTP(S), or known-secret success URLs before persistence.
- Randomized and unconditionally removed Cloudflare initial-stdin staging files, rejected mixed bridge versions before dispatch, and prevented inspect/retry calls from silently materializing destroyed runtimes.

### Known limitations

- SQLite intentionally supports one active control-plane writer.
- Local execution is not a sandbox; Cloudflare requires a deployed bridge and live account verification for the exact revision.
- Quotas/rate limits, horizontal coordination, large-log object retention, release signing, and additional deployment targets are not yet productized.
- Agent permission policy is predeclared and non-interactive; an interactive approval flow needs an explicit runner control channel.
- Interrupted workspace-bundle publication may leave unreferenced content-addressed bytes until an operator runs the explicit garbage-collection maintenance command.
- The pinned Cloudflare SDK exposes accumulated logs rather than range reads; bridge replay is limited to 4 MiB and larger histories require a provider-owned cursor/range facility or an external spool outside the workload sandbox.

## Compatibility policy

Version `0.1.0` established the first public HTTP schemas, runner and bridge protocols, database contract, artifact representation, agent catalog, and adapter contracts:

- breaking public API or persisted-format changes require a major release;
- additive backward-compatible API behavior may ship in a minor release;
- compatible fixes and security patches may ship in a patch release;
- runner and bridge mixed-version behavior must be stated independently from API SemVer;
- database state is accepted only when it matches the release's exact schema identity;
- security advisories identify affected and fixed versions without exposing active credentials or tenant data.

[Unreleased]: https://github.com/kohoj/meanwhile/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kohoj/meanwhile/releases/tag/v0.1.1
[0.1.0]: https://github.com/kohoj/meanwhile/releases/tag/v0.1.0
