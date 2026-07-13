# Runtime provider contract

This guide is for authors adding an isolated compute backend to Meanwhile. The implemented TypeScript source in `src/providers/runtime-provider.ts` is authoritative; [AGENTS.md](../AGENTS.md) defines the architectural invariants. This repository is pre-release, so verify the current versioned contract and shared test suite before building against it.

## Purpose

A runtime provider translates a small set of compute, process, event, file, and exposure primitives. It does not implement a run, understand an agent, or decide policy.

```text
run executor
    │ provider-neutral operations
    ▼
RuntimeProvider
    │ provider API / bridge protocol
    ▼
isolated compute
```

The boundary is process-aware rather than a one-shot command runner because cancellation, timeout, event replay, restart recovery, artifact capture, and cleanup all require durable identity beyond `exec(command)`.

## Ownership

The adapter owns:

- create, start, inspect, stop, and destroy of isolated compute;
- spawn, inspect, signal, wait, and sequenced events for a process;
- relative workspace file write, list, and read;
- optional port exposure;
- health and provider-native diagnostics;
- immutable adapter/runner/image/bridge provenance declarations;
- translation of provider failures into `RuntimeProviderError`.

The adapter never owns:

- authentication or owner authorization;
- agent selection, prompts, ACP, or permission policy;
- public run/deployment status;
- idempotency, timeout policy, or cleanup eligibility;
- audit policy, artifact retention, or deployment;
- API schemas or database access.

The provider may transport an opaque runner specification as initial stdin and secret values as process environment. It must not parse, persist, echo, or attach either to diagnostics.

## Contract surface

Conceptually:

```ts
interface RuntimeProvider {
  readonly name: string
  readonly capabilities: RuntimeCapabilities
  readonly provenance: RuntimeProviderProvenance

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

  writeFiles(runtime: RuntimeHandle, files: RuntimeFile[]): Promise<void>
  listFiles(runtime: RuntimeHandle, path: RelativePath, options: ListRuntimeFilesOptions): Promise<RuntimeFileInfo[]>
  readFile(runtime: RuntimeHandle, path: RelativePath, options: ReadRuntimeFileOptions): Promise<Uint8Array>

  expose?(runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint>
  health(): Promise<ProviderHealth>
}
```

Do not widen this interface with provider settings that belong in adapter construction. Do not return provider SDK objects across it.

## Provenance and capabilities

Capabilities are provider-neutral behavioral facts used by policy: isolation class, process recovery, event replay, port exposure, and exact signal semantics. Provenance identifies the accepted implementation: adapter version, runner digest when known, pinned runtime image reference/digest when known, and bridge protocol version.

The control plane hashes capabilities and snapshots both structures into every accepted run. Execution and recovery fail before compute if the active provider differs. Do not mutate these declarations after construction, infer stronger behavior from provider names, or fabricate an image digest that the platform does not expose.

## Handles

Runtime and process handles are opaque, versioned, JSON-serializable values. The control plane persists and returns them to the same adapter, but never branches on private fields.

A good handle contains only what the adapter requires to reconnect:

```json
{
  "kind": "runtime",
  "version": 1,
  "provider": "example",
  "opaque": "provider-defined-reconnect-identity"
}
```

The process handle uses the same envelope with `kind: "process"`. Handles must not contain:

- bearer tokens, API keys, repository credentials, or signed URLs;
- prompts or environment values;
- owner-readable host paths;
- unbounded provider response bodies.

Reject a handle with the wrong provider or unsupported version. Provider handles never cross the public API.

## Capabilities

Capabilities state facts that affect recovery and feature availability. They are not marketing labels and do not make unsupported behavior appear portable.

The initial contract describes exactly five properties:

- `isolation`: `none`, `container`, or `virtual-machine`;
- `processRecovery`: whether the process can be inspected after the original request ends;
- `eventReplay`: whether events can be resumed from a persisted provider cursor;
- `portExposure`: whether `expose` is implemented;
- `processSignals`: the exact signal semantics the adapter can honestly deliver.

Retention windows, hard limits, and provider lifecycle constraints belong in provider diagnostics and documentation until a provider-neutral product policy requires a versioned capability.

The core may branch on a capability. It may not branch on `provider.name`. If a capability cannot be expressed without leaking an SDK concept, first identify the provider-neutral product property it represents.

## Lifecycle semantics

### `create`

Allocates a provider resource and returns a persistable handle. It does not launch the agent. The provider may create compute in a stopped or initializing state, but `inspect` must report that truth explicitly.

If creation succeeds remotely and acknowledgement is lost, retry behavior must be documented. Prefer a provider-native idempotency identity derived from the supplied operation identity when available. Never return a handle for an unconfirmed resource.

### `start`

Makes a created runtime ready for process operations. Repeated calls against an already started runtime must be safe or return a stable non-retryable state error; choose one behavior and pass the shared contract.

### `inspect`

Reports provider facts such as creating, running, stopped, missing, or failed. It does not map these facts to Meanwhile run status. Missing is a fact, not automatic success or failure.

### `stop`

Stops active compute or its processes as the backend defines. It is idempotent. Stop is not destroy, and provider sleep/idle suspension must not be reported as destruction.

### `destroy`

Explicitly releases the resource. It is idempotent: a missing resource is already absent for cleanup purposes. This rule does not let `create` treat missing as success.

The adapter must never perform implicit durable-record deletion because destroy succeeded.

## Process semantics

### `ProcessSpec`

A process specification contains:

- a non-empty argv array whose first entry is the executable;
- normalized relative working directory;
- non-secret and resolved secret environment for that process;
- remaining relative timeout duration plus an explicit bounded hard-termination grace;
- optional bounded initial stdin.

No absolute control-plane deadline crosses this boundary. The control plane computes remaining policy time immediately before spawn; providers treat it as a duration and must not reinterpret it using sandbox wall-clock time.

Never accept a shell string. Never interpolate a prompt into argv or a shell. The fixed runner receives one validated specification through initial stdin; the prompt then travels to the child as ACP data.

The adapter must not log argv elements that may contain sensitive provider configuration, environment values, or initial stdin.

### `spawn`

Starts one independently identifiable process and returns a persistable handle. Runner stdout and stderr remain distinct channels. A PTY is not the protocol transport.

### `inspectProcess`

Reports provider process facts without deciding run status. If the backend cannot inspect after reconnect, declare that limitation in capabilities rather than fabricating an active or exited result.

### `events`

Returns ordered process events after the supplied cursor. Every event carries a monotonic opaque cursor suitable for the next call.

Requirements:

- cursors advance strictly within one process stream;
- replay after a cursor does not intentionally repeat an accepted event;
- a stale/expired cursor produces a distinguishable structured error;
- stdout and stderr identity is preserved;
- payload size is bounded before crossing the bridge;
- transport diagnostics are not injected into runner stdout.

The runner itself emits a separate monotonic sequence. The provider cursor resumes transport; the runner sequence deduplicates semantic frames; the database sequence serves public logs.

### `signal`

Maps the provider-neutral signal to the entire runner process group where the backend permits. Cancellation must not leave the agent child running after its runner exits. Unsupported signals fail explicitly.

### `wait`

Returns normalized exit evidence exactly once per observed exit, including exit code or signal when available. `wait` does not interpret agent success; the runner protocol and executor own that decision.

## File semantics

All paths crossing the contract are relative to the provider workspace and use one normalized separator. Reject:

- absolute paths;
- empty or parent traversal segments;
- NUL bytes and invalid encodings;
- paths that resolve outside the workspace;
- symlink escapes.

`writeFiles` receives bounded bytes plus a portable Unix permission mode and creates parent directories only within the workspace. The mode is part of immutable workspace identity: preserve it exactly, including executable intent, and fail before execution if the backend cannot. Define overwrite semantics explicitly and avoid partial publication.

`listFiles` returns stable metadata sufficient for safe artifact traversal. It must identify directories, regular files, and symlinks rather than silently following them.

`readFile` returns bytes, not decoded text. It must enforce configured size bounds before buffering an entire object.

The control plane applies artifact policy, but the provider must preserve enough filesystem truth for that policy to work.

## Exposure semantics

If supported, `expose(runtime, port)` returns a normalized endpoint with provider-native expiry or authentication metadata when relevant. It does not make the endpoint a deployment.

Exposure requirements:

- validate port range and provider restrictions;
- require the caller to establish that the workload is listening before exposure; process creation is not service readiness;
- do not place credentials in durable URLs when avoidable;
- report expiration truthfully;
- make endpoint cleanup follow runtime destruction;
- never proxy an untrusted preview onto the authenticated API origin.

Adapters without port exposure omit the optional method and declare the capability false.

## Health

`health()` performs a bounded provider diagnostic without creating billable compute unless the provider test route explicitly requests a lifecycle test. It reports configured/unconfigured, reachable/unreachable, protocol compatibility, and safe diagnostics.

Health output never includes credentials, raw provider bodies, account-private identifiers, or configuration values beyond safe source names.

`POST /providers/test` is owner-authorized control-plane behavior. It selects a registered adapter and normalizes the result; the provider does not define the public response schema.

## Errors

Provider failures retain enough internal structure to make policy and telemetry correct:

```ts
type ProviderError = {
  provider: string
  operation: string
  code: string
  message: string
  retryable: boolean
}
```

The actual source type is authoritative. Follow these rules:

- `code` is stable and bounded; do not use raw prose;
- `retryable` describes the immediate operation, not a hidden retry policy;
- raw bodies and causes may be retained only in non-public, redacted diagnostics;
- token, secret, prompt, file content, provider stack, and signed URL values are never safe details;
- expected missing-resource behavior is normalized per operation;
- timeouts, auth failure, quota, unsupported capability, invalid handle, expired cursor, and provider unavailability remain distinguishable.

The control plane converts this error to its public envelope and owns any explicit bounded retry schedule.

## Security boundary

An adapter is trusted control-plane code. The workload is not.

- Authenticate every remote bridge request.
- Scope bridge credentials to the smallest provider surface.
- Validate opaque handles and paths again at the bridge.
- Never accept an arbitrary provider handle from a client.
- Keep provider credentials in the control plane or bridge, never the workload.
- Treat any secret injected into a runtime as visible to all code in that runtime unless the provider proves a stronger boundary.
- Do not describe runner placement, filenames, or Unix users as isolation without a tested provider guarantee.

Read [Threat model](threat-model.md) before implementing file, process, preview, or secret behavior.

## Cloudflare bridge

Cloudflare-specific SDK types live only under `providers/cloudflare-sandbox/` and `src/providers/cloudflare-provider.ts`. The independently deployable bridge:

- authenticates the control plane;
- validates the versioned bridge request;
- translates to the official Sandbox SDK using its current RPC transport;
- applies and verifies declared workspace file modes through a fixed internal command because the pinned file API does not expose mode directly;
- starts the fixed runner with bounded initial stdin;
- when an SDK lacks direct initial stdin, may use a random provider-private staging file plus safely quoted redirection, provided the bytes never enter argv/diagnostics and the file is removed on every path;
- preserves runner stdout as protocol and stderr as diagnostics;
- provides cursor-bearing live/replayed events;
- advertises only hard termination for the pinned SDK, while control-plane stop destroys remaining sandbox processes after cancellation;
- performs explicit idempotent destruction;
- reports safe health and version compatibility.

Pin the Sandbox npm package and container image to matching exact versions. The bridge protocol has its own version because it is a deployment boundary; do not equate that version with the public API or runner protocol.

## Contract test suite

Every adapter, including local and fake, runs the same deterministic suite:

1. create → inspect → start → inspect;
2. write/list/read binary and nested workspace files;
3. reject absolute, traversal, and symlink-escape paths;
4. spawn argv without a shell and preserve stdout/stderr identity;
5. stream and resume events without duplication;
6. inspect and wait for normal and non-zero exits;
7. signal the process group and observe termination;
8. enforce or accurately report timeout limitations;
9. stop and destroy idempotently;
10. treat cleanup of a missing resource as already absent;
11. expose a port when capability is true;
12. normalize authentication, unavailable, expired cursor, and invalid-handle errors;
13. ensure diagnostics and handles contain no injected secret;
14. reconnect according to declared capabilities;
15. preserve declared workspace file modes;
16. keep provenance immutable and reject configuration drift before an execution uses the adapter.

Use injected identities and bounded event-driven waits; do not use arbitrary sleeps. A fake proves core replaceability. A local adapter proves real host process semantics. Each remote adapter additionally needs a credential-gated live test that creates, starts, executes, reads, stops, and destroys actual provider compute.

## Author checklist

- [ ] No SDK type appears in the stable contract or run executor.
- [ ] Provider construction owns all provider-specific configuration.
- [ ] Handles are versioned, persistable, opaque, and secret-free.
- [ ] Capabilities state limitations truthfully.
- [ ] Provenance names the exact adapter, runner, image evidence, and bridge protocol without guessing unavailable digests.
- [ ] Process launch uses executable plus argv.
- [ ] Events are ordered, bounded, resumable, and channel-aware.
- [ ] Stop and destroy are idempotent and distinct.
- [ ] Paths and symlinks cannot escape the workspace.
- [ ] Workspace file modes survive the adapter boundary exactly.
- [ ] Errors are structured, safe, and operation-specific.
- [ ] Provider credentials never enter workload environment.
- [ ] Shared contract tests pass.
- [ ] A real lifecycle test proves the remote integration.
- [ ] Documentation names residual provider limitations.
