# Threat model

Meanwhile remotely executes repositories and agent actions that may be untrusted. Security is therefore an architectural boundary, not an input-sanitization feature.

This document states the implemented model and its residual risks. It is not a certification; controls should be trusted only to the strength of their matching proof. Report security issues through [SECURITY.md](../SECURITY.md).

## Security goals

Meanwhile aims to provide:

1. **Owner isolation** — one authenticated owner cannot discover, read, cancel, interrupt, deploy, or fetch evidence/artifacts from another owner's resources.
2. **Control-plane integrity** — workload code cannot choose durable run/session/turn state, forge authorization, supply provider handles, or reach the database directly.
3. **Credential minimization** — agent source credentials remain behind a trusted, revocable egress boundary; setup/deployment values enter only their trusted operation; no value or placeholder becomes durable output.
4. **Remote workload isolation** — untrusted code runs in a provider isolation boundary, not in the control-plane process.
5. **Artifact integrity** — captured output is declared, bounded, traversal-safe, immutable, content-addressed, and owner-scoped.
6. **Deployment integrity** — deployment promotes an authorized immutable source; it never executes from an arbitrary host or live runtime path.
7. **Explainable mutation** — security-sensitive actions and state changes leave append-only audit evidence correlated to requests and traces.
8. **Safe failure** — public errors and diagnostics do not reveal credentials, provider bodies, SQL, stack traces, prompts, private paths, or cross-owner existence.

## Explicit non-goals

The initial architecture does not claim to:

- make the local provider a sandbox;
- make an explicitly authorized model/API destination trustworthy;
- prevent an agent from exfiltrating workspace data to an explicitly allowed destination;
- defend against a malicious root/operator on the control-plane host;
- defend against compromise of the selected cloud provider's isolation boundary;
- provide portable outbound-network policy on providers that do not implement the mediation contract;
- guarantee availability against unlimited workload, storage, bandwidth, or provider-billing abuse;
- make a runner file, Unix user, environment variable, or same-sandbox process a security boundary;
- provide horizontal multi-writer database isolation;
- prove third-party agent, package, container-image, or model-provider supply-chain integrity merely by pinning a version.

Use short-lived, least-privilege source credentials and narrow exact-host/method grants when these residual risks matter.

## Assets

High-value assets include:

- owner API keys and key hashes;
- control-plane, Cloudflare bridge, repository, model, and deployment credentials;
- prompts, repository inputs, source code, process output, and artifacts;
- run/session/turn/deployment state, event journals, logs, audit history, and ownership relationships;
- opaque runtime/process handles;
- control-plane database and artifact bytes;
- provider account resources, quota, and billing;
- preview and deployment URLs;
- runner, agent executables, container images, and dependency provenance.

## Actors

| Actor | Trust |
| --- | --- |
| Authenticated owner | Trusted for its own resources, untrusted across tenants and toward infrastructure |
| Upstream agent/client | Equivalent to the API key it holds; may send hostile input |
| Repository/workspace | Untrusted code and data |
| ACP agent/model output | Untrusted execution decisions and content |
| Control-plane process | Trusted computing base |
| Runtime provider adapter/bridge | Trusted computing base for translation and credentials |
| Remote sandbox provider | Trusted to enforce its documented isolation properties |
| Deployment target | External trusted dependency with scoped credentials |
| Local host administrator | Fully trusted; can read or alter local state |
| Internet client | Unauthenticated and hostile by default |

An API key is authority, not identity proof beyond its owner binding. Anyone holding it acts as that owner until revocation.

## Trust boundaries

```text
hostile client
    │ bearer key + validated JSON
────┼──────── public API boundary ─────────────────────
    ▼
trusted control plane ───── SQLite / ArtifactStore
    │ authenticated versioned provider request
────┼──────── provider bridge boundary ────────────────
    ▼
trusted credential broker ── encrypted lease state
    │ opaque placeholder + default-deny exact-host egress
────┼──────── sandbox isolation boundary ──────────────
    ▼
remote sandbox
    ├── meanwhile-runner
    └── ACP agent + repository code       untrusted
         │ outbound network
─────────┼──────── external service boundary ──────────
         ▼
 model / repository / deployment services

immutable artifact
    │ separate origin
────┼──────── preview browser boundary ────────────────
    ▼
untrusted HTML / script / media
```

The runner and agent share one runtime. Code in that sandbox can observe its filesystem, processes, and environment, including opaque capability placeholders. The runner is a protocol and lifecycle boundary, not a confidentiality boundary. For Cloudflare, outbound network is separately mediated in the trusted Worker/Container boundary.

## Assumptions

- TLS terminates at a trusted ingress for every non-loopback API and bridge connection.
- The control-plane host, data directory, deployment environment, and process supervisor are administered securely.
- SQLite and artifact storage are available only to the control-plane service account and trusted operators.
- Provider and deployment SDKs enforce their documented account boundaries.
- The Cloudflare bridge authenticates every request and rejects incompatible protocol versions.
- API, runner, provider bridge, exact database schema, and artifact format versions are deployed as one tested release unit.
- The control-plane clock is sufficiently accurate for persisted deadline instants, token expiry, and audit ordering. Sandbox clocks are untrusted; runner duration uses a relative monotonic budget and provider timestamps do not order durable evidence.
- Exact known secret values and issued placeholders are available to the redactor before any corresponding output is consumed.
- Operators do not run untrusted workloads through the local provider.

If an assumption is false, the associated guarantee is invalid; fail closed where it is observable.

## Threats and controls

### Authentication and tenant isolation

| Threat | Control | Residual risk |
| --- | --- | --- |
| Guess or steal API key | High-entropy bearer keys, shown once, persisted as hashes with safe prefixes, revocable key identity, and non-cacheable protected responses | Bearer theft grants owner authority until revocation |
| Submit another `ownerId` | Public bodies never accept owner identity; auth context supplies it | Compromised auth middleware affects all routes |
| Enumerate another owner's ID | Every public store method scopes by owner; cross-owner result is `NOT_FOUND` | Timing and aggregate-capacity side channels require separate review |
| Use leaked provider/storage handle | Handles never cross public APIs and are validated by adapter/bridge | Trusted logs or database compromise can expose handles |
| Cross-owner artifact dedup leak | Authorization and owner-scoped storage key precede byte lookup; no public global digest oracle | Storage-level aggregate side channels remain possible to operators |

Authorization must be structural. A route-level precheck followed by an unscoped SQL read is not sufficient.

### Input and process execution

| Threat | Control | Residual risk |
| --- | --- | --- |
| Prompt shell injection | Prompt is ACP data; process launch uses executable plus argv, never `sh -c` | The agent may intentionally run dangerous commands inside its sandbox |
| Agent-specific output spoofing | ACP SDK and versioned bounded runner frames; no terminal scraping | A compromised agent may send valid but malicious ACP content |
| Malformed runner event | Zod validation, protocol/run identity, sequence checks, size bounds, fail-fast protocol errors | Provider transport truncation may make recovery impossible |
| Reordered or replaced session command | Durable command sequence, stable command ID, provider-side sequence/fingerprint binding, exact-retry semantics | A compromised trusted bridge can still alter delivery |
| Fresh agent substituted after restart | Persisted process identity, event replay, ACP session identity, explicit `continuity_lost` on unrecoverable compute | Providers without recovery cannot promise continuity |
| Child survives cancellation | Signal the runner process group; runner terminates its child group; stop/destroy as cleanup | Provider signal guarantees vary and must be capability-tested |
| Resource exhaustion | Deadlines, file/log limits, process lifecycle, provider quotas, cleanup monitoring | A permitted run can still consume budget up to limits |

The agent is expected to modify files and run tools; sandbox isolation, credentials, limits, and durable evidence contain that authority. Attempting to classify every agent command as safe is not the model.

### Workspace and artifacts

| Threat | Control | Residual risk |
| --- | --- | --- |
| Path traversal | Normalized relative paths; reject absolute paths, `..`, NUL, and provider-root escape | Provider filesystem bugs remain in the trusted base |
| Symlink escape | Do not follow untrusted symlinks across workspace boundary; verify resolved targets during capture | Races require provider-appropriate no-follow/atomic primitives |
| Artifact storage exhaustion | Declared paths, file-count, per-file, total-size limits, and streaming bounds | Many authorized runs can exhaust owner/global quota without higher-level quotas |
| Partial or mutable artifact | Atomic write then publish metadata; content digest; no in-place mutation | Hash implementation or storage compromise can violate integrity |
| Secret in artifact | Scan for exact resolved secret bytes before persistence; reject or quarantine and audit | Encoded, transformed, derived, or newly obtained secrets may evade exact matching |
| Malicious media | Preserve bytes and safe media metadata; previews use a hostile-content origin | Users who download/open artifacts still assume client-side risk |

Artifact capture is not a general recursive copy. The collector reads only declared logical paths and treats every filesystem entry as hostile.

### Secrets

| Threat | Control | Residual risk |
| --- | --- | --- |
| Persist resolved value | Store only `secretRefs`; bind resolution and lease attachment to durable resource identities; keep values encrypted in trusted broker state; expose placeholders only; await local material release and durable revocation | Trusted control-plane/provider compromise can observe source credentials |
| Leak through logs/errors/audit/telemetry | Runner redaction plus an independent control-plane redactor covering source values and placeholders across the full observation lifetime; safe structured errors; forbidden telemetry fields | Unknown, fragmented, or encoded sensitive data may pass; a broken provider boundary can violate the guarantee |
| Leak control-plane/provider credential to workload | Provider, bridge, artifact-store, and deploy credentials stay outside agent runtime | Adapter implementation defects can violate the boundary |
| Cross-tenant environment lookup | Process-environment catalog is bootstrap-owner only, deny-by-default, target-bound, and reserves platform names | Additional tenants require a tenant secret-manager adapter; this catalog is intentionally not one |
| Repository credential confused deputy | Environment resolver rejects checkout credentials; a future broker must bind owner, repository host, and lifetime | Private checkout is unavailable until that stronger boundary exists |
| Model key exfiltration | Secret-bearing admission requires `RuntimeCredentialBroker`; agent receives only a revocable placeholder; exact host/method substitution and response stream redaction occur in trusted outbound handling; all other egress is denied | The authorized destination can receive workspace data, transform or otherwise disclose credentials, or itself be compromised; source credentials may still be long-lived |

Secret redaction is defense in depth. The credential guarantee comes from the broker/egress boundary, not string replacement.

### Runtime provider and bridge

| Threat | Control | Residual risk |
| --- | --- | --- |
| Forged bridge request | TLS, high-entropy bridge token, constant-time credential check where applicable, request validation | Shared-token theft grants bridge authority until rotation |
| Replay or confused version | Versioned bridge protocol, operation/resource scoping, bounded request identity | Strong anti-replay may require signed requests/nonces in a later protocol |
| Conflicting process-input retry | Each process sequence binds once to one secret-safe command fingerprint; exact retry is idempotent and conflicting reuse fails closed | Durable bridge-state compromise bypasses the binding |
| Provider SDK leaks business logic | SDK types confined to adapter/bridge; core contract is provider-neutral | Adapter remains trusted code and needs review |
| Sleep mistaken for cleanup | Explicit idempotent destroy; cleanup state and audit evidence | Provider-side asynchronous deletion may lag acknowledgement |
| Sandbox peer reads runner files/placeholders | Do not rely on same-sandbox process/file separation; expose only revocable opaque placeholders | Workload can use an active placeholder through its exact authorized destination until revocation |
| Orphaned billable compute | Persist handles before further work, durable cleanup, reconciliation, backlog metrics, operator runbook | Lost acknowledgement or provider outage can delay destruction |

Control-plane policy may branch on declared capabilities, never provider name. A provider must state inability to replay or recover rather than fabricate it.

### Deployment and preview

| Threat | Control | Residual risk |
| --- | --- | --- |
| Deploy another owner's output | Authorize run and source under same owner before creating deployment | Compromised store/adapter breaks the check |
| Deploy mutable/live workspace | Resolve artifact/workspace selector to immutable captured bytes before adapter call | Captured malicious content remains malicious |
| Arbitrary host-path deployment | Public API accepts logical source selectors only | Trusted operator tooling needs separate safeguards |
| Deployment credential leak | Permit only adapter-declared secret targets, resolve refs only for the adapter operation, and redact logs/errors | Target SDK/process can observe supplied credential |
| Adapter returns an unsafe URL | Canonical HTTP(S)-only validation rejects credentials, controls, oversized values, and exact known secrets before success is persisted | The destination itself may still serve malicious content |
| Target succeeds before evidence commits | Keep ambiguous work `running`; replay the idempotent adapter by stable deployment ID and immutable source | A non-idempotent third-party target cannot satisfy this adapter contract |
| Preview steals API authority | Separate origin/port, no API cookies, unguessable identity, defensive headers | User browser/network environment can still be attacked by hostile content |
| MIME sniffing or script execution | Conservative media type, `nosniff`, CSP, no server-side execution | A static preview intentionally may execute its own client script within its origin |
| Local preview bytes drift after publication | Restart, backup, and restore require the canonical manifest, exact file graph, and per-file digest | A trusted host administrator can still mutate bytes between verification and a request |

`local-static` is a deployment adapter, not a trusted rendering engine.

### Persistence, state, and audit

| Threat | Control | Residual risk |
| --- | --- | --- |
| Duplicate run/session/turn/deployment admission or terminal race | Independently scoped idempotency keys, canonical hashes, atomic record/audit commits, and CAS state/version transitions | Database compromise bypasses invariants |
| Late success overwrites cancel/timeout | Atomic runner-result reservation plus one immutable public terminal claim | Incorrect transaction ownership is a critical implementation defect |
| Cleanup destroys active runtime | Eligibility joined to authoritative run or session state in claim transaction | Provider handle aliasing must be prevented by adapter validation |
| Audit diverges from mutation | State change and audit record share one transaction | Local administrator can rewrite SQLite; audit is not externally tamper-proof |
| Restart loses accepted evidence | Persist state/log cursor before acknowledgement; replay and deduplicate | A provider without replay can lose unaccepted in-flight output |
| Second writer corrupts local truth | Adjacent lease keyed by physical data-root identity excludes another service, maintenance command, or symlink alias | Host administrator can remove locks or mutate storage |
| Backup omits or legitimizes unrelated bytes | Exclusive quiescent maintenance; standalone SQLite serialization; exact referenced object/preview graph; hashed manifest; read-only verification | Backup remains offline and depends on trusted local filesystem/hash implementation |
| Garbage collection deletes live bytes | Reachability derives from durable references; dry-run/apply are separate; quiescence and lease are required | Storage/DB compromise can forge the reference graph |

Audit is append-only application evidence, not a cryptographic transparency log. Operators requiring tamper resistance must export it to an append-only external system in a future explicit boundary.

### API, diagnostics, and availability

| Threat | Control | Residual risk |
| --- | --- | --- |
| Error-based data disclosure | One safe error envelope; stable codes; raw details stay internal and redacted | Timing and response-size differences need testing |
| SSE amplification | Auth, owner scoping, cursor bounds, connection/backpressure limits | Authorized clients can still consume allocated resources |
| Provider-test billing abuse | Health is bounded and non-provisioning by default; explicit lifecycle proof is gated | Authorized users may consume quota through legitimate runs |
| High-cardinality telemetry attack | Bounded labels; IDs stay in logs/traces; payload fields bounded | Log volume still requires retention and owner/global quotas |
| Storage/queue denial | Explicit input/log/artifact limits, deadlines, bounded process admission, cleanup monitoring | Per-owner/global quotas and request rate limits remain production evolution work |

## Local provider warning

The POSIX-only local provider runs agent and repository code as host processes. Directory scoping, a different working directory, runner placement, environment filtering, and process groups do not make it a sandbox.

Use it only for:

- deterministic tests;
- the no-account demo with trusted fixtures;
- trusted local development.

Do not expose a local-provider-enabled control plane to untrusted tenants. Secret-bearing agent runs and sessions are rejected on local because it has no mediation boundary. Stronger local isolation belongs in a container/VM runtime provider that passes the same contracts and has an independently reviewed threat model.

## Cloudflare-specific boundary

Processes inside one Cloudflare Sandbox share a sandbox security context, including filesystem, processes, and network according to the provider model. Therefore:

- the runner cannot keep a same-sandbox “protected journal” from a malicious agent;
- broker placeholders are visible to sandbox code, but source credential values remain encrypted behind the Worker/Durable Object boundary;
- agent-phase egress is default-deny and limited to exact host/method grants; redirects cannot widen it;
- provider/account credentials remain in the control plane or bridge;
- provider-owned process replay is a recovery facility, not a trusted signature of agent intent;
- the session mailbox is a delivery mechanism, not a confidentiality boundary; the workload may observe same-sandbox files;
- the bridge durably reserves a command sequence/fingerprint before mailbox publication because the pinned SDK has no ongoing stdin primitive;
- durable credential revocation is required after terminalization and before explicit Sandbox destruction;
- bridge and container versions are deployed and tested as one compatibility unit.

Cloudflare isolation protects the control-plane host from the sandbox; it does not isolate one process inside the sandbox from another.

## Supply chain

- Commit `bun.lock` after the first real install and review changes.
- Pin the Cloudflare Sandbox package and container image to matching exact versions.
- Build the standalone runner reproducibly and record its digest in release artifacts.
- Persist the accepted runner, agent catalog, adapter, capability, image, and bridge identities with each run; leave unavailable platform digests null.
- Keep third-party SDKs at their owning boundary.
- Minimize production dependencies and remove unused packages.
- Run type, lint, unit, integration, protocol, and credential-gated live provider tests before release.
- Review agent executables and ACP adapters as privileged workload components.
- Do not execute untrusted contribution code with production secrets.

Pinning improves reproducibility; it does not establish trust. Critical upstream advisories and provenance still require review.

## Security verification

Required adversarial tests include:

- cross-owner read, list, cancel, interrupt, close, turn, event, artifact, deployment, log, and existence probes;
- duplicate idempotency and competing terminal-state claims;
- prompt and argv metacharacters without shell execution;
- malformed, oversized, duplicated, conflicting, out-of-order, and wrong-run/session/turn runner frames and commands;
- absolute path, traversal, symlink race, and undeclared artifact attempts;
- exact secret values in stdout, stderr, ACP updates, provider errors, audit metadata, telemetry, artifacts, and deployment logs;
- preview path escape, MIME confusion, CSP, cache isolation, and API-origin separation;
- forged, missing, rotated, and incompatible bridge credentials/protocols;
- restart during provisioning, running, an active session turn, artifact capture, deployment, and destroy;
- provider event replay expiry and missing compute;
- future/malformed sandbox timestamps, UTC agent environment, and monotonic timeout enforcement;
- missing/tampered execution provenance and adapter/capability drift before compute;
- cleanup attempts against a running run or operational session;
- data-root lease exclusion, backup tampering, nested paths, restore consistency, and garbage-collection reachability.

Tests assert stable error codes, ordering, side effects, and absence of secret bytes. They use deterministic clocks and adapters rather than arbitrary sleeps.

## Incident handling

When a credential or tenant boundary may be compromised:

1. stop admission and revoke affected API/bridge/provider/deployment credentials;
2. stop or destroy affected runtimes when doing so preserves more safety than evidence;
3. quarantine deployments and artifacts without distributing suspected secret content;
4. preserve restricted database, audit, operational, provider, and deployment evidence;
5. identify the first boundary that accepted or emitted unsafe data;
6. notify affected owners through a private channel;
7. fix the owning boundary and add a regression test across every output plane;
8. rotate credentials and verify cleanup/provider inventory;
9. publish a security advisory with safe remediation and compatibility details.

Do not copy suspected secret material into issues, chat, test fixtures, commits, or ordinary logs.

## Review triggers

Update this model before shipping any of the following:

- interactive human approval or a new runner control channel;
- another authentication method or operator role;
- horizontal writers or a shared database;
- material expansion of public artifact download, log export, or audit query semantics;
- object storage, external log storage, or deduplication across owners;
- changes to outbound network policy or credential mediation;
- a new runtime provider, deployment target, or preview mode;
- persistent runtime reuse between runs;
- user-supplied container images or runner binaries;
- web UI, browser authentication, or cookies;
- online backup or disaster-recovery automation.

Security documentation changes with the controlling code and tests, never after the fact.
