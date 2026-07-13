# Changelog

All user-visible, operator-visible, compatibility, migration, and security-relevant changes to Meanwhile are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a public compatibility baseline exists.

## [Unreleased]

### Added

- Bun/Hono/Zod control plane with generated OpenAPI, bearer-key authentication, owner-scoped run/deployment APIs, cursor polling, and resumable SSE logs.
- Explicit SQLite migrations and a single SQL store for runs, status events, idempotency, runtime cleanup, runner sessions, logs, immutable inputs, artifact metadata, deployments, and append-only audit evidence.
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
- Executable documentation contracts for local links, JSON examples, and the published agent-catalog template.
- Typed Web-standard client with resource namespaces, shared runtime-validated contracts, structured errors, deterministic terminal waits, response evidence, and replay-safe asynchronous log following.
- Bounded link-free Bun workspace capture as a separate client entrypoint and direct client contract coverage.
- Complete owner-scoped resource namespaces across HTTP, SDK, and CLI for artifact inspection/streaming download, deployment history, audit queries, and API-key create/list/revoke with final-key lockout protection.
- Immutable per-run execution provenance covering agent/catalog, runner, provider adapter/capabilities, runtime image evidence, and bridge protocol, with idempotency participation and fail-closed drift detection.
- Exclusive local data-root lease plus quiescent hashed backup/verification, staged restore, and explicit dry-run/apply reachability garbage collection.
- `bun run proof:release` system proof for agent execution, immutable download, deployment, runtime destruction audit, process restart, persisted preview/history, and verified backup, plus a real-provider Cloudflare variant that requires complete configured execution provenance.

### Changed

- The complete quality gate now builds the standalone runner and bundled demo agent before tests, so a clean checkout proves the same executables used by local and remote runtimes.
- Container CI now boots the packaged image and drives a complete SDK run, ACP evidence, artifact capture, deployment, and separate-origin preview flow instead of stopping at readiness.
- Agent launch configuration is now strict, portable, capability-derived, content-digested, and snapshotted into each run's durable idempotent intent; recovering runs no longer change behavior after catalog edits. The shipped catalog advertises only the bundled demo agent, with external ACP adapter entries supplied as documentation templates.
- Run creation may omit `provider`; the configured default is resolved and validated before any run or uploaded workspace state is persisted.
- Local preview URLs now use an explicit browser-facing origin whenever the server binds all interfaces, so deployment records never publish wildcard bind addresses.
- Source-checkout CLI examples use the executable `bun run cli --` path and `doctor` no longer performs an implicit runner build.
- Compose publishes only loopback host ports, makes its unsafe local-provider choice explicit, and accepts optional provider plus allowlisted `env://` values through an uncommitted runtime env file.
- Cloudflare bridge protocol v2 now binds process retries to a secret-safe full-spec fingerprint, requires an explicit version header, keeps lifecycle truth in a separate durable registry, advertises only the SDK's hard-termination capability, and bounds accumulated replay to 4 MiB of UTF-8 output.
- CLI and executable demos now consume the same public client as external callers; public Zod contracts are separated from Hono registration, and hermetic demo-environment setup no longer obscures the SDK usage path.
- Runner protocol v2 carries a remaining timeout duration instead of a cross-machine wall-clock deadline; ACP children run in UTC, monotonic elapsed time owns runtime duration, and durable event timestamps come from control-plane acceptance.
- Successful local-static previews resume their separate listener after a control-plane restart.

### Fixed

- Local process recovery now reads Linux kernel process identity directly instead of requiring a `ps` utility that minimal production images do not contain.
- Sparse telemetry correlation is canonicalized before validation, preventing an unavailable optional identifier from obscuring the original failure.
- The production image now carries both versioned protocol modules required by the control-plane import graph, and CI boots the built image through `/readyz` instead of treating a successful image build as runtime proof.
- Doctor diagnostics now distinguish migration-history incompatibility from filesystem writability.
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

- No tagged release exists.
- SQLite intentionally supports one active control-plane writer.
- Local execution is not a sandbox; Cloudflare requires a deployed bridge and live account verification for the exact revision.
- Quotas/rate limits, horizontal coordination, large-log object retention, release signing, and additional deployment targets are not yet productized.
- Agent permission policy is predeclared and non-interactive; an interactive approval flow needs an explicit runner control channel.
- Interrupted workspace-bundle publication may leave unreferenced content-addressed bytes until an operator runs the explicit garbage-collection maintenance command.
- The pinned Cloudflare SDK exposes accumulated logs rather than range reads; bridge replay is limited to 4 MiB and larger histories require a provider-owned cursor/range facility or an external spool outside the workload sandbox.

## Compatibility policy

Until the first tagged release, public HTTP schemas, runner and bridge protocols, database migrations, artifact representation, agent catalog, and adapter contracts may change. Changes must still be deliberate, versioned where they cross a process or persistence boundary, tested for rejection/upgrade behavior, and recorded above.

After a compatibility baseline is declared:

- breaking public API or persisted-format changes require a major release;
- additive backward-compatible API behavior may ship in a minor release;
- compatible fixes and security patches may ship in a patch release;
- runner and bridge mixed-version behavior must be stated independently from API SemVer;
- released migrations are immutable and upgrades move forward through new migrations;
- security advisories identify affected and fixed versions without exposing active credentials or tenant data.

Release links will be added when the repository has a canonical public origin and first tag.
