# ADR 0012: Local Companion, Conversation Mirrors, and local-first execution

- Status: accepted
- Date: 2026-07-27
- Deciders: maintainer
- Extends ADRs 0006, 0009, and 0011 without changing Run or AgentSession lifecycle authority.

## Context

Meanwhile's current execution path assumes that the control plane creates the
`Run` or `AgentSession`, provisions its runtime, launches the runner, and owns
the resulting lifecycle. That path is necessary for durable execution custody,
but it is not the only place where real delegated work already happens.

People often have Codex.app, Codex CLI, or Claude Code open on their own Mac.
Those tools already own the agent process, interactive context, permissions,
credentials, and lifecycle. Requiring a second cloud-hosted agent before a
Project room becomes useful would make Cloudflare the product instead of an
optional runtime adapter. Pretending an already-running external conversation
is a Meanwhile `Run` would be worse: the UI could imply cancellation, recovery,
artifact, or terminal-state authority that Meanwhile does not possess.

The intended local-first journey is therefore:

1. sign in to the deployment and enter Connected Onboarding;
2. pair one local **Meanwhile Companion** and explicitly choose which agent
   sources and Projects it may share;
3. continue using Codex.app, Codex CLI, or Claude Code normally;
4. see an authorized linked conversation appear in the same Project Live Deck;
5. open its complete live transcript, fold agent work, annotate exact source
   moments, and Relay one moment to another Project participant;
6. create new Meanwhile-owned work in a real local sandbox when execution
   custody is desired.

Observation and execution are separate ingress paths into one collaboration
experience. They must converge only in the Project read model.

## Decision

### 1. Two truthful work paths

Meanwhile supports two work paths with different authority:

```text
Meanwhile-owned work
  browser / SDK / CLI
      -> Run or AgentSession
      -> RuntimeProvider
      -> meanwhile-runner + ACP agent
      -> authoritative execution state, cleanup, artifacts, deployment

Source-owned work
  Codex.app / Codex CLI / Claude Code
      -> local source adapter
      -> Companion durable outbox
      -> ConversationMirror + MirrorEvent
      -> observation, collaboration, no execution control
```

`Run` and `AgentSession` remain the only execution lifecycles Meanwhile owns.
The new durable collaboration object is `ConversationMirror`; the product calls
it a **Linked conversation**. A mirror is an append-only custody record of what
one explicitly authorized external source reported. It is not a recovered,
imported, or partially managed AgentSession.

The Project work projection becomes a tagged union:

```text
ProjectWorkItem = run | session | mirror
```

That union exists at the read-model boundary. It does not create a common
mutable status machine underneath the three objects.

### 2. Durable objects and ownership

The source-owned path introduces four explicit records:

- `ConnectorDevice` — one revocable, Principal-bound Companion installation;
- `ConversationShareGrant` — an explicit, revocable permission for that device
  and source kind to publish a locally selected conversation into one Project;
- `ConversationMirror` — one immutable `(Owner, Project, delegator Principal,
  source kind, pseudonymous source-session identity)` binding;
- `MirrorEvent` — one versioned, bounded, append-only normalized source event.

The Project, Project GitHub repository ID, and delegating Principal on a mirror
are immutable. The server accepts mirror creation only when the Connector
claims the exact active Project binding. The supported Companion first proves
device-locally that the selected transcript workspace resolves to a Git root
whose `origin` names that same GitHub repository; neither the local path nor
remote URL is uploaded. Current
`participate` access is required to create or continue publishing a mirror.
Current `watch` access may read it. Removing Project access closes long-lived
reads. Revoking the device or share grant rejects future ingestion but leaves
already accepted Project history readable to people who still have Project
access and retains its attribution.

A device credential is not an API key or browser session. The preferred browser
pairing path is proof-of-possession adoption: the local CLI generates the
high-entropy Connector secret, opens an authenticated Board approval URL that
contains only its non-secret prefix and SHA-256 verifier, and the person chooses
one Project before the control plane atomically creates the device and its first
share grant. The plaintext secret therefore moves directly into the OS
credential store and never crosses the browser, URL, Board BFF, control-plane
response, shell history, LaunchAgent, or local profile. A short verification
fingerprint is rendered in both terminal and browser so the person can detect a
misdirected approval. Exact retries may return the same device and grant;
changing the source, verifier, Principal, or first Project fails closed.

The administrative API may still issue and return a high-entropy secret once
for explicit headless provisioning, but browser onboarding never uses that
path. Both paths store only a digest server-side and give the device only
route-exact setup receipt, mirror registration, ingestion, checkpoint, and
heartbeat capabilities. Neither grants Project read,
Run creation, lifecycle command, Relay, Annotation, membership, repository,
artifact, Brief, or deployment authority. The plaintext belongs in the local
OS credential store, never a repository, transcript, browser storage, or
control-plane log.

`ConversationShareGrant` is the privacy and ambient-capture boundary. Pairing a
device does not authorize content upload. A person separately selects the exact
GitHub-bound Project and source kind that may receive a locally selected
conversation. The Companion separately records the exact source record and
workspace path on-device solely to prove the matching GitHub origin. Discovery
may inspect a bounded set of local
session metadata to show a local-only chooser, but it never equates "most
recently modified" with consent. Interactive setup requires the person to
choose one candidate; non-interactive setup requires an exact transcript handle
or source conversation identity. The selected source identity is frozen into
the local profile and verified again before any event is staged. An ambiguous
or unmatched local conversation remains local until the person chooses both it
and a Project. A non-Git repository or different GitHub origin fails closed
before the outbox accepts content. Broad home-directory upload and
installation-wide capture are invalid defaults.

### 3. Source adapter boundary

The Companion owns source discovery and normalization behind a small adapter
contract. The control plane never parses Codex or Claude private files and the
Board never talks to a local agent process.

```ts
interface ConversationSourceAdapter {
  readonly kind: "codex" | "claude-code"

  discover(signal?: AbortSignal): AsyncIterable<SourceConversationNotice>
  read(
    source: SourceConversationHandle,
    cursor: SourceCursor,
    signal?: AbortSignal,
  ): AsyncIterable<NormalizedMirrorEvent>
  inspect(source: SourceConversationHandle): Promise<SourceObservation>
}
```

Handles and cursors are adapter-private and remain on the device. Normalized
events cross the network only after schema validation, local redaction, and
share-grant matching. The local redactor covers every publishable text field,
including human and assistant messages, reasoning, tool inputs and outputs,
titles, statuses, and source diagnostics. It removes the exact Connector secret,
known credential forms, and known private home roots before the durable outbox;
the replay digest is computed from the redacted payload that may leave the
device, never from the raw text. Redaction rules are versioned and expose only
aggregate local diagnostics, not the matched value.
The initial event vocabulary is deliberately small and source-neutral: a human
or assistant `message`; a foldable `work` block classified as reasoning, tool,
plan, or system; and an observed `source_status`. Tool results, usage,
permissions, and requests for input remain structured inside the appropriate
bounded work/system block until a source-neutral interaction contract earns a
new event type. Unknown source events remain local and surface a safe connector
diagnostic; they are never guessed into a known semantic type.

Source-specific decisions are:

- **Codex.app and Codex CLI:** use explicitly permitted local session records as
  the replayable source and user-level hooks only as low-latency wake-ups. A
  separate `codex app-server` process cannot be represented as an attachment to
  an already-running app-server process, so app-server is not the attach
  boundary. It may be used later for Companion-owned sessions behind a distinct
  capability.
- **Claude Code:** use documented hook payloads, including the exact
  `transcript_path`, as wake-ups and tail the selected transcript as the
  replayable source. Structured stream JSON is valid for Companion-owned
  launches, not proof that an unrelated interactive process is controllable.
- **Hosted remote-control features:** may coexist, but neither Anthropic nor
  OpenAI cloud relay is a required transport or identity authority for
  Meanwhile.

The Companion never writes an agent transcript, impersonates the source CLI,
sends a prompt, approves a tool, interrupts a turn, or copies the source app's
credentials. Any future control capability requires its own provider-documented
protocol, user authorization, command identity, acknowledgement, and ADR.

### 4. Normalization is evidence-preserving, not source replacement

`MirrorEvent` stores a stable schema version, positive mirror sequence, source
segment identity, source-event digest, normalized type, bounded content,
source-observed time when available, and the control-plane acceptance time.
Local absolute paths, source-app credentials, environment values, provider
tokens, and unselected raw envelopes do not cross the Companion boundary.

The raw source transcript remains authoritative for the external tool. The
accepted normalized event is authoritative only for what Meanwhile received
and shared. UI copy therefore says `Linked conversation`, names the source, and
distinguishes `Observed live`, `Sync paused`, and `Source ended` from Run states
such as `running`, `failed`, or `succeeded`.

Normalization may fold or redact presentation, but must not silently repair,
reorder, or synthesize source content. Parser version and source digest remain
available for diagnosis. Optional raw-envelope diagnostics require a separate
explicit consent and retention policy; they are not part of the default
contract.

### 5. Replay and failure semantics

The Companion maintains a bounded durable local outbox. It assigns each mirror
a contiguous positive sequence and retains an event until the control plane
acknowledges the highest contiguous accepted sequence.

Ingestion obeys exact replay rules:

- first `(mirrorId, sequence)` commits the event and its digest;
- exact sequence and digest is an idempotent retry;
- exact sequence with different content fails closed;
- a gap is rejected with the last accepted checkpoint;
- reconnect resumes after the acknowledged checkpoint;
- source rotation or truncation pauses the attachment and requires an explicit
  reattachment decision; prior accepted events are never rewritten.

Control-plane or network failure must not interfere with the local agent. It
only delays sharing. Device restart resumes the durable outbox. Control-plane
restart resumes from SQLite. Parser incompatibility pauses the affected source
and reports it without emitting guessed content. Outbox overflow pauses capture
and calls for attention rather than deleting an unacknowledged middle. Device
revocation, Project-access loss, or share-grant revocation denies new batches
without deleting already shared Project truth.

Companion heartbeat is connectivity evidence only. Agent activity appears only
when a source event states it; silence must not be fabricated as completion.

The macOS packaging adapter installs one user LaunchAgent per exact local
profile. The profile freezes source, source conversation ID, Project,
transcript path, control-plane origin, and outbox path but contains no
credential; the revocable Connector secret lives in macOS Keychain. Discovery
returns only a bounded device-local list of source ID, short title, modification
time, and path. A non-interactive start without an explicit ID or transcript
fails closed; no adapter may silently choose the newest file. Runtime status is
a small private local diagnostic projection, never another server-side
lifecycle. Pause unloads the LaunchAgent without revoking Project consent.
Resume reloads the same profile and checkpoint. Uninstall removes the service
and Keychain item while preserving the outbox unless the user explicitly
requests destructive purge. Other platforms may provide another supervisor
adapter without changing the Companion, mirror, authorization, or Project
contracts.

### 6. Project and Board projection

Lobby and Live Deck compose mirrors beside native work through the public
Project API. A mirror card shows:

- immutable delegator and source app;
- observed state and last successfully synced time;
- bounded human-agent preview with working details folded;
- an explicit `Linked` source affordance;
- no Stop, Cancel, Interrupt, Send, Deploy, Artifact, or continuity-recovery
  control unless a separate owned object actually supplies that capability.

Opening the card uses the existing Conversation Detail reading model. A
presentation adapter maps `MirrorEvent` into the same message, reasoning, tool,
plan, and usage blocks used for native task events without copying them into a
Run or Session journal. SSE follow reads the durable mirror sequence and
revalidates Project access during the stream.

Lobby, Project Room, and Conversation Detail are stable addressable browser
states. A Project Room uses `/projects/:projectId`; a detail uses
`/projects/:projectId/conversations/:kind/:id`. Refresh, back/forward navigation,
OAuth return, a Relay, and local Companion setup preserve or recover that
address without putting credentials in it. Proof-of-possession approval opens
the Project Room as soon as Project consent commits, so it becomes the visible
workbench while the Companion confirms the exact local conversation. The
Linked card still appears only from authoritative Project work data, and a
detail handoff targets a real accepted mirror rather than an optimistic client
object.

Task Annotation and Task Relay anchors extend their tagged task reference to
`mirror`. Their exact source identity is `(mirrorId, sequence, block identity,
quote context, offsets, digest)`. This lets Project members mark and hand off an
exact source moment while keeping the annotation or relay outside the mirror
event journal. A Relay still transfers human attention, not agent control.

### 7. Local sandbox is the preferred owned-execution topology

The existing `local` process provider remains a deterministic development
adapter and must continue to report `isolation: none`. It is not renamed or
quietly described as a sandbox.

Meanwhile-owned tasks should preferentially target a separate local sandbox
provider on supported installations. The first backend may use OCI containers
through Colima/Docker-compatible tooling; Apple Container may implement the
same `RuntimeProvider` contract on compatible macOS releases. Backend selection,
image packaging, filesystem mounts, network policy, process replay, cleanup,
and health remain adapter concerns. No container backend name enters Run,
Session, Project, transcript, or Board semantics.

The local sandbox and the Companion do not share authority:

- a mirrored Codex.app or Claude Code credential is never copied into a
  container;
- a sandboxed agent is admitted with credentials only when that provider
  implements the existing mediation contract;
- the Companion cannot operate a sandbox Run;
- the sandbox provider cannot read unrelated local source transcripts.

Cloudflare remains a supported optional remote runtime, not the default product
entrance or a prerequisite for real-agent collaboration. Local-only,
self-hosted, private-network, public-cloud, and optional managed deployments use
the same mirror API, authorization, event, and Project semantics. The Companion
makes outbound authenticated requests only; a user device needs no inbound
public port.

### 8. Privacy and consent

The first-run product surface must make four decisions legible before capture:

1. which local Companion is paired;
2. which source applications it may observe;
3. which exact Projects or repository/workspace bases may receive sessions;
4. what transcript content and metadata leave the device.

The default is deny and local-only. Existing hooks must be merged
non-destructively and their installed changes shown to the user. Disabling a
source removes Companion-owned hook entries without deleting unrelated user
configuration. `Pause sharing` stops future capture immediately; `Disconnect
device` revokes its credential. Already accepted shared history is immutable
Project truth and follows the installation's control-plane data-root retention
and backup policy rather than silently disappearing when one client
disconnects. The initial contract has no per-mirror delete endpoint. Any future
purge must specify audit, Relay/Annotation-anchor, and backup consequences in a
separate contract.

The Companion redacts known credentials and private local paths before the
outbox, applies size limits before persistence, and never treats model output as
trusted instructions. TLS is required off loopback. Deployment-specific
encryption at rest and backup policy remain operator responsibilities and must
be disclosed truthfully.

## Delivery and acceptance

The implementation proceeds as one vertical path, not disconnected demos:

1. contracts, additive schema, device/share authorization, exact replay, and
   deterministic Codex/Claude fixture adapters;
2. Companion pairing, exact source discovery, private macOS LaunchAgent and
   Keychain installation, durable outbox, status, pause/resume/uninstall,
   ingestion, restart, revocation, and gap/conflict tests;
3. Project `mirror` projection, Live Deck card, Conversation Detail follow,
   foldable work, Annotation, and Relay anchors;
4. local sandbox provider with explicit isolation and credential-mediation
   capability checks, then the same RuntimeProvider contract suite;
5. a clean local proof using a real Codex.app or Claude Code session, followed
   by two-person Project acceptance on one deployable control plane.

Deterministic source fixtures prove parser and replay behavior. A local file
tail proves only local source observation. Two test Principals prove
authorization behavior. None of those alone proves that two real people shared
a real external agent conversation. Acceptance claims remain separated.

## Consequences

- Meanwhile becomes useful with the agents people already use, without
  surrendering its owned execution and recovery architecture.
- Project rooms can contain native and linked conversations without lying about
  which system owns lifecycle control.
- A small outbound Companion is now a first-class open-source component and
  security boundary.
- Local sandbox execution can become the default owned-work path while
  Cloudflare stays optional.
- Source adapters carry version churn and privacy filtering locally; core
  authorization, replay, and Project semantics stay source-neutral.
- Device pairing, share grants, outbox retention, source-version compatibility,
  and local hook hygiene become explicit operational responsibilities.

## Rejected alternatives

- Importing an external transcript as a `Run` or `AgentSession`.
- Scraping terminal pixels, accessibility text, or network traffic as the
  durable transcript source.
- Treating a newly launched app-server as control of an existing Codex.app
  process.
- Depending on Claude Remote Control or another vendor relay for core sync.
- Giving a Companion a normal API key or browser session.
- Uploading every transcript discovered under a user's home directory.
- Copying Codex.app, Claude Code, GitHub, or model credentials into a local
  container.
- Rewriting accepted mirror history after a source file rotates or is edited.
- Adding lifecycle controls to a linked-conversation card because the UI can
  render them.
- Making Cloudflare, Apple Container, Colima, Docker, or a managed service part
  of the product identity.
