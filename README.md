# Meanwhile

**The open control plane for running any coding agent in any isolated runtime.**

> Bring your agent. Bring your sandbox. Meanwhile owns the run.

Meanwhile accepts a repository or file bundle, an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agent, a task, and a runtime provider. It provisions disposable compute, records durable run evidence, captures immutable artifacts, cleans up the runtime, and can deploy the captured result through the same API, SDK, or CLI.

```console
bun run cli -- run --agent demo --provider local --files ./workspace -- <task>
bun run cli -- logs <run-id> --follow
bun run cli -- deploy <run-id> --artifact dist --target local-static
```

> [!IMPORTANT]
> Meanwhile is pre-release: the complete local product path and Cloudflare bridge are implemented, but no stable compatibility or production-support promise exists yet. Trust the executable checks and stated limits below, not the version number alone.

## Why Meanwhile exists

Moving a coding agent into a remote container is easy. Owning the run when processes race, the API restarts, a provider disappears, a secret reaches output, or cleanup fails is the actual product.

Meanwhile keeps five responsibilities deliberately separate:

```text
control plane ── decides policy and durable state
provider      ── executes compute, process, and file primitives
runner        ── speaks ACP to the agent inside the runtime
artifact store── owns immutable output bytes
deploy adapter── promotes immutable output to a target
```

A run is not a runtime. A runtime is disposable; run history is not. A deployment never reaches back into a mutable workspace. Provider logs report facts but never decide authoritative run status.

Read [Architecture](docs/architecture.md) for the complete model and [Threat model](docs/threat-model.md) before accepting untrusted work.

## Implemented product surface

- Owner-isolated run creation, listing, inspection, cancellation, logs, and artifacts.
- Explicit `queued → provisioning → running → terminal` state transitions.
- Persisted deadlines, cancellation intent, restart reconciliation, and durable cleanup.
- Idempotent run creation with conflicting-key detection.
- Immutable, content-addressed artifacts and API-driven deployment.
- Owner-scoped artifact inspection/download, deployment history, audit queries, and API-key lifecycle through the same API, SDK, and CLI.
- A full local path that needs no cloud account.
- A real Cloudflare Sandbox provider behind an independently deployable bridge.
- ACP-native agent execution through the same runtime-local runner everywhere.
- A typed Web-standard client with durable waits, resumable log iteration, runtime response validation, and the same structured error contract as HTTP.
- Immutable execution provenance, UTC evidence semantics, and monotonic runtime timeout enforcement across clock domains.
- A single-writer data-root lease plus verified backup, restore, and explicit garbage collection.
- Structured errors, append-only audit evidence, JSON logs, traces, and metrics.

The local provider is for development, deterministic tests, and demos. **It is not a security sandbox and must not run untrusted code.** Use a genuine isolation provider for untrusted repositories or prompts.

## Quick start

### Prerequisites

- [Bun 1.3.13 or newer](https://bun.sh/) on the control-plane host.
- Git when runs use repository input.
- An ACP-capable agent executable, or the deterministic fixture used by the demo.
- Docker Compose 2.24+ for the container path; a Cloudflare account is required only for the remote Cloudflare path. Wrangler is provider tooling and may require the runtime declared by its pinned release; it is not a Meanwhile application process.

### Local no-account flow

```console
bun install
cp .env.example .env
bun -e 'import { issueApiKey } from "./src/auth.ts"; console.log("MEANWHILE_API_KEY=" + (await issueApiKey()).key)' >> .env
bun run runtime:build
bun run doctor
bun test
bun run demo
```

`bun run demo` is the acceptance path: create a local run, follow its logs, capture an artifact, and publish it through `local-static` without a cloud account.

`bun run proof:release` is the stronger no-account release path. It additionally proves runtime-destruction audit, artifact-download integrity, a control-plane restart, persisted preview/history reads, and a complete hashed backup.

To run the service directly:

```console
bun run dev
```

The default target addresses are:

- API: `http://127.0.0.1:7331`
- Local artifact preview: `http://127.0.0.1:7332`
- OpenAPI: `http://127.0.0.1:7331/openapi.json`
- Liveness/readiness: `/healthz` and `/readyz`

Migrations are explicit and transactional. Service startup applies pending migrations before accepting work; `doctor` checks the same database and storage paths without printing credentials.

### Container deployment

The persistent local topology is:

```console
export MEANWHILE_API_KEY='<local bootstrap key>'
docker compose up --build
```

Mount `MEANWHILE_DATA_DIR` on durable storage. Do not run two active control-plane writers against the same SQLite database. See [Operations](docs/operations.md) for backup, recovery, and production checks.

Compose binds the container listeners on `0.0.0.0` but publishes both host ports on `127.0.0.1` only. It explicitly enables the unsafe local provider because this topology is a trusted-machine demo, not an isolation boundary. Do not expose it to untrusted tenants or widen the host bindings while `local` is enabled.

Optional provider configuration and allowlisted agent secret values belong in an uncommitted runtime env file:

```console
cp compose.env.example compose.env
# edit only the provider settings and env:// values this deployment needs
MEANWHILE_ENV_FILE=./compose.env docker compose up --build
```

The file is optional, so source-checkout commands continue to use Bun's ordinary shell/`.env` environment. `MEANWHILE_SECRET_ENV_ALLOWLIST` is a local-bootstrap catalog, not a multi-tenant secret manager: only that bootstrap owner may address it, source and target names must match, and reserved control-plane/provider variables can never be listed. Empty is deny-all. Repository credentials require a future owner- and host-scoped broker and are intentionally rejected by the environment resolver.

Compose defaults the browser-facing preview origin to `http://127.0.0.1:7332`. Set `MEANWHILE_PREVIEW_PUBLIC_URL` to the real external HTTP(S) origin when deploying behind a proxy; wildcard bind addresses are never returned as deployment URLs.

## API

Every protected request uses a bearer API key. `MEANWHILE_API_KEY` exists only to bootstrap a local development owner; production keys are high-entropy values shown once and stored only as hashes. Protected responses default to `Cache-Control: private, no-store`, including one-time key creation responses.

```console
export MEANWHILE_URL=http://127.0.0.1:7331
export MEANWHILE_TOKEN='<local bootstrap key>'
```

### Create a run

Do not send `ownerId`; identity comes from the bearer key.

```console
curl --fail-with-body \
  -X POST "$MEANWHILE_URL/runs" \
  -H "Authorization: Bearer $MEANWHILE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-refactor-001' \
  --data '{
    "workspace": {
      "type": "repository",
      "url": "https://github.com/example/project.git",
      "revision": "main"
    },
    "agentType": "demo",
    "prompt": "Complete the deterministic task.",
    "provider": "local",
    "env": {},
    "secretRefs": {},
    "artifactPaths": ["dist"],
    "timeoutMs": 900000
  }'
```

The same owner and idempotency key with the same canonical request returns the original run. Reusing it for different input returns HTTP `409` with `IDEMPOTENCY_CONFLICT`.

`provider` is optional. When omitted, Meanwhile resolves `MEANWHILE_DEFAULT_PROVIDER`, validates that it is registered, and canonicalizes the resolved name for idempotency before persisting the run.

For uploaded input, replace `workspace` with an immutable inline file bundle. Paths are normalized, duplicate/traversal-shaped names are rejected, and request/file limits are enforced before persistence:

```json
{
  "workspace": {
    "type": "files",
    "files": [
      {
        "path": "README.md",
        "contentBase64": "IyBIZWxsbyBmcm9tIE1lYW53aGlsZQo="
      }
    ]
  }
}
```

Inline files are snapshotted and hashed before the first blob write. Their canonical bundle identity participates in idempotency, so an identical retry returns the existing run and a conflicting retry writes no candidate bytes. Publication is owner-scoped and commits through the workspace-bundle catalog before the run is queued; an existing bundle reference is fully read and verified before new run intent is persisted.

The CLI provides the safer directory-upload path: `bun run cli -- run --files ./workspace --agent demo --artifact site -- <task>`. Source checkouts use `bun run cli --`; a future installed package may expose the shorter `meanwhile` executable, but no package release is claimed yet.

### TypeScript client

The SDK is the canonical programmatic consumer of the HTTP contract. It uses Web `fetch`, `AbortSignal`, streams, and the same Zod schemas that generate OpenAPI; it does not import Hono application state, provider types, SQL, or service implementations. The CLI is a presentation layer over this client rather than a second HTTP implementation.

From this checkout:

```ts
import { Meanwhile } from "meanwhile"
import { captureWorkspace } from "meanwhile/workspace"

const apiKey = process.env.MEANWHILE_API_KEY
if (!apiKey) throw new Error("MEANWHILE_API_KEY is required")

const meanwhile = new Meanwhile({
  baseUrl: process.env.MEANWHILE_URL ?? "http://127.0.0.1:7331",
  apiKey,
})

const created = await meanwhile.runs.create(
  {
    workspace: { type: "files", files: await captureWorkspace("./workspace") },
    agentType: "codex",
    provider: "local",
    prompt: "Build the requested change.",
    artifactPaths: ["dist"],
    timeoutMs: 15 * 60_000,
  },
  { idempotencyKey: crypto.randomUUID() },
)

const run = await meanwhile.runs.wait(created.id)
const deployment = await meanwhile.deployments.create({
  runId: run.id,
  artifactPath: "dist",
  deployTarget: "local-static",
})
const published = await meanwhile.deployments.wait(deployment.id)

console.log(published.url)
```

`runs.followLogs()` is an `AsyncIterable` over validated durable log records. It reconnects with `Last-Event-ID`, deduplicates replay, rejects sequence gaps, honors caller cancellation, and never exposes transport heartbeats as product logs. `MeanwhileError` preserves the server's stable code, status, request ID, and safe details. Successful response evidence can be observed through `onResponse` without recording bodies or credentials.

The generic client is browser-disabled by default because a bearer API key must not be bundled into untrusted frontend code. `captureWorkspace` is a separate Bun entrypoint because filesystem access does not belong in the Web-standard transport client.

### Inspect and follow

```console
curl --fail-with-body \
  -H "Authorization: Bearer $MEANWHILE_TOKEN" \
  "$MEANWHILE_URL/runs/<run-id>"

curl -N \
  -H "Authorization: Bearer $MEANWHILE_TOKEN" \
  -H 'Accept: text/event-stream' \
  "$MEANWHILE_URL/runs/<run-id>/logs?after=0&follow=true"

curl --fail-with-body \
  -H "Authorization: Bearer $MEANWHILE_TOKEN" \
  "$MEANWHILE_URL/runs/<run-id>/artifacts"
```

Polling and SSE use the same durable cursor. Reconnect with the last accepted cursor to avoid gaps or duplicates.

Artifacts remain independently inspectable and downloadable after runtime cleanup:

```console
bun run cli -- artifacts list <run-id>
bun run cli -- artifacts get <artifact-id>
bun run cli -- artifacts download <artifact-id> --path index.html --output ./index.html
```

The download path streams immutable bytes and exposes their digest and size. The CLI writes atomically, verifies both, and refuses to overwrite an existing file.

### Cancel

```console
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $MEANWHILE_TOKEN" \
  "$MEANWHILE_URL/runs/<run-id>/cancel"
```

Cancellation is idempotent. It records intent before signalling the process, claims `cancelled` once, and schedules runtime cleanup. A late process exit cannot rewrite the terminal state.

### Deploy immutable output

```console
curl --fail-with-body \
  -X POST "$MEANWHILE_URL/deployments" \
  -H "Authorization: Bearer $MEANWHILE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "runId": "<run-id>",
    "artifactPath": "dist",
    "deployTarget": "local-static",
    "config": {},
    "secretRefs": {}
  }'
```

Exactly one of `artifactPath` or logical `workspacePath` identifies a captured immutable source. Deployment never reads a live runtime or arbitrary host path. `local-static` serves output on the separate preview origin.

Owner-facing operational resources use the same client boundary:

```console
bun run cli -- deployments list
bun run cli -- audit list --resource-type run --resource-id <run-id>
bun run cli -- api-keys create --name automation
bun run cli -- api-keys list
bun run cli -- api-keys revoke <key-id>
```

New key material is returned once; only its hash and safe prefix persist. The final active key cannot be revoked, preventing accidental owner lockout.

### Structured failures

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

Provider bodies, stack traces, SQL, absolute host paths, prompts, and secrets are never public error details.

The complete contracted route set also includes `GET /runs`, `GET /artifacts/:id`, `GET /artifacts/:id/content`, `POST /providers/test`, `GET /deployments`, `GET /deployments/:id`, `GET /deployments/:id/logs`, `GET /audit`, `POST|GET /api-keys`, `DELETE /api-keys/:id`, `GET /healthz`, `GET /readyz`, and `GET /openapi.json`. `src/api/contracts.ts` is the implemented request/response schema source; the OpenAPI document and client types derive from it, and README examples do not override it.

## Agents and ACP

`config/agents.json` is the only active agent launch catalog. A fresh checkout contains only the bundled deterministic `demo` agent, so its advertised default is genuinely runnable. [docs/agents.example.json](docs/agents.example.json) contains explicit Codex, Claude Code, and Hermes ACP adapter templates to copy into the active catalog after installing those executables in the selected runtime image.

An entry declares a bare PATH executable, argv, stdio ACP transport, working-directory policy, expected capabilities, and allowed environment names. Catalog objects are strict and validated once at startup. Run creation snapshots the selected launch definition, its derived least-privilege permission policy, and both definition and catalog digests into durable intent. Queued and recovering runs therefore execute the definition they accepted even if `config/agents.json` changes after a restart. There are no agent-specific command strings or host-path resolution in routes or the executor.

Claude Code, Codex, Hermes, OMP, or another agent can be selected when it exposes ACP. A CLI without native ACP needs a small ACP adapter executable. Meanwhile does not scrape agent-specific terminal output.

The prompt travels as ACP protocol data, never inside `sh -c` or an interpolated command. The fixed `meanwhile-runner` is the ACP client colocated with the agent, which keeps the bidirectional session inside the runtime rather than stretching stdio through a cloud API.

### Real local Codex proof

After `codex login`, run:

```console
bun run demo:codex
```

Keep the verified Codex-generated preview running for inspection with:

```console
bun run demo:codex:serve
```

This is an explicit live proof, not part of the deterministic default test suite. Bun installs the exact `@agentclientprotocol/codex-acp@1.1.2` adapter and a compatible exact Codex runtime into a disposable tools directory, then creates an uploaded workspace through the public SDK/API path, persists ACP lifecycle evidence, captures Codex's generated static artifact, deploys it through `local-static`, and fetches the resulting preview. It does not accept `succeeded` alone: the proof requires the expected artifact bytes to be served from the deployment URL.

The proof verifies the installed CLI's login and passes the existing `CODEX_HOME` plus the disposable exact `CODEX_PATH` only as ephemeral secret references. Neither path is written into the run request, database, logs, artifacts, or output, and the ChatGPT authentication file is never copied. Because the local provider is not a sandbox, run this only with a workspace and agent you trust. Remote Codex packaging remains the responsibility of the selected provider image.

### Real local Claude Code proof

With an authenticated Claude Code installation, run:

```console
bun run demo:claude
```

Keep the verified Claude-generated preview running with `bun run demo:claude:serve`. The proof installs exact `@agentclientprotocol/claude-agent-acp@0.58.1` and `@anthropic-ai/claude-agent-sdk@0.3.205` packages in a disposable tools directory, then exercises the same SDK/API, ACP evidence, artifact, deployment, and HTTP preview assertions as the Codex proof.

The proof reads only the explicit `env` object from `~/.claude/settings.json`. Authentication values and private endpoints enter through ephemeral secret references, while an allowlist admits only known non-secret Claude controls; the adapter never receives the rest of the user configuration, plugins, transcripts, or history. Auto-memory and agent view are disabled for the disposable run. No credential is copied into the workspace or retained by Meanwhile. Provider-side authentication or quota failures remain structured failed runs rather than being mistaken for an ACP integration failure.

## Providers

Providers implement one narrow, process-aware contract: compute lifecycle, process lifecycle and replay, workspace files, optional port exposure, and health. They do not see owner policy, public run status, artifact retention, deployment rules, or SQL.

- `local` must exercise the complete contract but offers no isolation.
- `cloudflare` talks to the independently deployable bridge in `providers/cloudflare-sandbox/` through a versioned authenticated protocol.
- A deterministic fake proves replaceability, the local provider proves host process semantics, the bridge suite proves translation, and the credential-gated live test is the release proof against a real account.

See [Provider contract](docs/provider-contract.md) to add a runtime without changing the run executor.

### Cloudflare configuration

Deploy the bridge package, configure its authentication secret, then set:

```dotenv
MEANWHILE_DEFAULT_PROVIDER=cloudflare
CLOUDFLARE_BRIDGE_URL=https://<bridge-worker>
CLOUDFLARE_BRIDGE_TOKEN=<high-entropy shared credential>
CLOUDFLARE_RUNNER_DIGEST=<sha256 of the deployed meanwhile-runner>
CLOUDFLARE_RUNTIME_IMAGE_DIGEST=sha256:<deployed image digest when available>
```

Set `CLOUDFLARE_BRIDGE_URL` to the deployed bridge URL. Set the control plane's `CLOUDFLARE_BRIDGE_TOKEN` to the same secret value stored in the bridge-side `BRIDGE_TOKEN` binding. Never put either credential name in an agent catalog or run environment.

The bridge owns translation to Cloudflare Sandbox primitives, not business state. A separate durable runtime registry prevents inspection or retry from accidentally recreating a destroyed Sandbox. Every authenticated request also declares the exact bridge protocol version. The SDK and container image versions are pinned together. `bun run cloudflare:check` proves the package and bridge contract; `bun run --cwd providers/cloudflare-sandbox image:check` builds the real container path.

The pinned SDK exposes accumulated process logs rather than a range read. The bridge therefore enforces a 4 MiB UTF-8 replay ceiling, validates prefix continuity, and treats truncation as `EVENT_REPLAY_GAP`; it does not pretend an agent-writable same-sandbox journal is durable evidence. Larger remote logs require a provider-owned cursor/range primitive or an external spool outside the workload security context.

Agent availability is a runtime property. `meanwhile doctor` checks catalog executables on the host only when the local provider is admitted; Cloudflare agent availability is established by the pinned provider image and the credential-gated live test, not by resolving executables on the control-plane host.

The deterministic suite never touches Cloudflare merely because credentials exist. Remote billing and mutation require an explicit command:

```console
CLOUDFLARE_BRIDGE_URL=https://<bridge-worker> \
CLOUDFLARE_BRIDGE_TOKEN='<bridge token>' \
bun run test:live:cloudflare
```

That command sets the opt-in gate itself and fails, rather than skips, when either credential is absent. Run it against the exact deployed bridge revision before enabling production traffic.

The complete remote control-plane proof is stricter:

```console
bun run proof:release:cloudflare
```

It requires both provenance digest variables, then drives the real provider through run, ACP evidence, artifact capture/download, local-static promotion, runtime destruction, restart recovery, and backup verification. Those digest values are operator/platform assertions used for identity pinning and drift detection, not a cryptographic runtime attestation claim. A platform digest that is not available stays `null` in ordinary runs; Meanwhile never invents provenance.

## Persistence and data model

SQLite in WAL mode is the authoritative store for one active control-plane writer. Artifact bytes live in an owner-scoped content-addressed store under `MEANWHILE_DATA_DIR`; SQLite contains metadata and references only.

The durable model separates:

- owners and hashed API keys;
- runs, immutable input references, state events, runtime instances, and runner cursors;
- sequenced run logs;
- immutable artifact metadata;
- deployments and sequenced deployment logs;
- append-only audit records;
- schema migrations and durable cleanup state.

Terminal run state is immutable. Cleanup has its own state and never deletes the durable evidence planes.

Every accepted run stores a self-verifying execution-provenance snapshot: agent definition/catalog digests, runner digest when known, provider adapter/capability identity, pinned runtime image reference/digest when known, and bridge protocol version. It participates in idempotency. Execution and recovery fail closed if the active provider no longer matches it; legacy rows without provenance remain readable but cannot be re-executed.

### Data-root lifecycle

The service and maintenance commands share one adjacent lease, so a second writer cannot open the same local control plane. Stop the service before maintenance:

```console
bun run cli -- data backup --output ../meanwhile-backup
bun run cli -- data verify ../meanwhile-backup
bun run cli -- data restore ../meanwhile-backup
bun run cli -- data gc --dry-run
bun run cli -- data gc --apply
```

Backup output must be outside the live data root. A backup contains a normalized SQLite snapshot, every referenced workspace/artifact object, persisted preview bytes, migration identities, release/Bun versions, and a digest for every file. Restore accepts only an absent or empty root. Garbage collection removes only unreferenced content-addressed objects and preview trees, is dry-run-first, and never deletes run history or referenced bytes.

## Security model

- Every public lookup is owner-scoped; cross-owner access returns `NOT_FOUND`.
- Public requests cannot supply owner IDs, provider handles, storage keys, or host paths.
- Non-secret `env` may be persisted; `secretRefs` are resolved immediately before use and never stored as values. The built-in environment source is bootstrap-owner scoped, deny-by-default, and cannot supply repository credentials.
- Redaction is established before process output is consumed and covers logs, telemetry, errors, audit metadata, artifacts, and deployment logs.
- Artifact paths are relative, declared, bounded, traversal-safe, and checked for symlink escape.
- Untrusted previews use an origin separate from the authenticated API.
- Public timestamps are UTC ISO 8601 instants accepted by the control plane. Provider/runner wall clocks do not order durable evidence; runtime timeout duration uses a monotonic budget, and ACP agent processes receive `TZ=UTC`.

Any credential intentionally supplied to an agent must be considered visible to that agent. Redaction limits accidental known-value leakage; it cannot prevent deliberate transformation or network exfiltration. Prefer short-lived, least-privilege, per-run credentials.

Read [Threat model](docs/threat-model.md) for assumptions and residual risks. Report vulnerabilities through [Security policy](SECURITY.md).

## Observability

Meanwhile keeps three evidence planes separate:

1. run logs for the owner;
2. operational JSON logs, OpenTelemetry traces, metrics, health, and diagnostics;
3. append-only audit evidence for mutations and security-sensitive actions.

Critical boundaries carry request, trace, owner, run, runtime, process, deployment, provider operation, and state-transition identifiers where applicable. Prompts, file contents, credentials, and process output are not telemetry attributes.

## Commands

```console
bun run dev                 # control plane with reload
bun run cli -- help         # CLI from this source checkout
bun run typecheck           # strict TypeScript
bun test                    # deterministic suite
bun run check               # complete gate: Biome, types, notices, runtime build, and tests
bun run doctor              # configuration and dependency diagnostics
bun run demo                # no-account end-to-end path
bun run demo:codex          # explicit locally authenticated Codex ACP proof
bun run demo:codex:serve    # retain the verified local preview for inspection
bun run demo:claude         # explicit locally authenticated Claude Code ACP proof
bun run demo:claude:serve   # retain the verified Claude preview for inspection
bun run proof:release       # cleanup, restart, and backup no-account release proof
bun run proof:release:cloudflare # full real-provider proof with configured execution provenance
bun run runner:build        # standalone Bun runner
bun run cli -- data gc --dry-run # inspect unreachable durable bytes
bun run cloudflare:check    # bridge package checks
bun run cloudflare:dev      # bridge development process
bun run cloudflare:deploy   # bridge deployment
bun run test:live:cloudflare # explicit real-account lifecycle proof
bun run notices:check       # production dependency notice drift
```

See [Contributing](CONTRIBUTING.md) for the quality gate.

## Current limits

- There is no tagged compatibility baseline or production support policy yet.
- Local execution is not isolation.
- SQLite supports one active control-plane writer.
- Recovery is only as strong as a provider's process identity and event replay.
- Redaction cannot stop deliberate exfiltration by code that receives a credential.
- Cloudflare operation needs an account, deployed bridge, and an account-level live verification of the exact revision.
- `local-static` is the no-account deployment target; additional targets are adapters, not core branches.
- Quotas/rate limits, HA/multi-writer coordination, object-backed large-log retention, and release signing are not yet productized.
- Agent permissions are predeclared and non-interactive; interactive human approval requires an explicit bidirectional runner control channel.
- A control-plane crash during multi-blob workspace publication can leave unreferenced content-addressed bytes. They cannot be addressed as a bundle without the catalog commit and are removed only by an explicit maintenance garbage-collection pass.

The source of truth for architectural invariants is [AGENTS.md](AGENTS.md). The deterministic suite, no-account demo, container build, and credential-gated provider proof are separate gates because no one of them establishes production readiness alone.

## AI assistance

AI agents assist with implementation, tests, documentation, and review. The durable architecture decisions remain explicit and human-reviewable: ownership boundaries, failure semantics, trust model, dependency selection, and acceptance proof live in this repository rather than in generated conversation history. Contributions produced with AI are held to the same test, security, licensing, and review requirements as any other change.

## License

Licensed under the [Apache License 2.0](LICENSE). Bundled production dependency identities and license texts are recorded in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES); `bun run notices:check` keeps that generated inventory aligned with installed production graphs.
