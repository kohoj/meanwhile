# Shared Project definition

This document is the controlling product and acceptance contract for
Meanwhile's Shared Project milestone. ADR 0009 selects Connected Onboarding
→ Project Lobby → Live Deck → Conversation Detail as the product hierarchy. The
ADR 0011 access model makes that journey reachable through optional GitHub
authorization without turning GitHub into the work control plane. The
implementation status and remaining proof boundary are recorded here rather
than hidden behind UI claims.

## Current ADR 0009 and 0011 override

The Live Deck is now the Project-room reference surface. One acrylic sheet equals
one authoritative Run or AgentSession and shows its human delegator, agent,
explicit state, bounded conversation preview, and foldable-work summaries.
Opening the sheet enters the complete native conversation. The former Project
Watch master-detail and Room Pulse sections below are retained as implementation
and decision history; where they conflict with this section, ADR 0009 controls.

The product contracts are explicit rather than simulated:

- ExternalIdentity plus separate GitHub/Google sign-in credentials;
- separate repository grants, local Project bindings, and agent connections;
- expiring client-scoped PresenceLease, never membership-as-online;
- durable Project-visible Annotation anchored to exact transcript source text;
- TaskRelay retained as addressed acknowledgement-bearing handoff;
- no second task lifecycle, copied transcript, Project activity journal, or
  user-facing `evidence` mode.

## Why the route is now fixed

The route was paused until product form, attention semantics, identity,
authorization, browser authentication, aggregation, and migration were chosen
together. Those choices are now explicit: Project Lobby above Live Deck and Conversation Detail, stable Principals,
Owner-contained Projects, explicit local membership plus current provider-derived
access, delegator-only lifecycle
authority, opaque browser sessions with only narrow self-Run and Relay write capabilities,
polling plus native task events, and exact additive migrations.

## Product north star

> In one shared Project, every authorized participant can see work delegated by
> every other participant, understand its current condition at a glance, and open its task
> detail and conversation without gaining control over somebody else's
> agent.

Before entering one Project, the Lobby must show only the Projects the current
identity is qualified to enter and make live work or personal Relay attention
legible without fabricating presence. GitHub may optionally supply repository
eligibility, while Meanwhile retains delegation and lifecycle authority.

The smallest proof is:

```text
Alice delegates work through an upstream agent, API, SDK, or CLI
        ↓
Project P shows the work live and attributes it to Alice
        ↓
Bob opens it and reads the prompt, conversation, outcome, and available outputs
        ↓
Bob Relays one exact transcript moment to Alice; Alice acknowledges it
        ↓
Bob cannot issue lifecycle commands against Alice's work
```

Generic social comments, mentions, reactions, task assignment, workflow
columns, agent orchestration, and editing remain outside this acceptance floor.
ADR 0009 adds expiring PresenceLease and exact source-anchored transcript
Annotation. Both are implemented. TaskRelay remains the addressed handoff
contract and is not collapsed into marginalia.

## Implemented current state

The source now implements:

- API keys bound to stable person/service Principals inside one Owner tenant;
- Projects, explicit maintainer/member membership, provider-derived
  watch/participate/administer access, and effective participant projection;
- immutable Project and delegator bindings on Runs and AgentSessions;
- effective Project participant reads of work, task conversation, artifacts,
  Briefs, and deployments, with current membership or matching provider grant
  checked at access time;
- delegator-only Run/Session lifecycle commands and deployment creation;
- Principal-scoped Run, Session, and Deployment idempotency;
- opaque expiring browser sessions that are revocable and deny-by-default except
  for exact Run creation, delegator-authorized Run cancellation, connected
  onboarding, PresenceLease heartbeat/release, Relay and Annotation writes, and
  session self-revocation routes;
- a typed Project namespace in the public client;
- typed Task Relay API and SDK contracts with append-only authorship,
  recipient-only acknowledgement, audit, and Project-scoped reads;
- typed Task Annotation API and SDK contracts with exact transcript anchors,
  immutable authorship, author-or-maintainer resolution, audit, and
  Project-scoped reads, exact source reconstruction, and the selected
  Conversation Detail marginalia interaction;
- public CLI commands for Principal, Project, membership, and per-Principal key
  administration, one-time Principal invitation creation/revocation, plus
  explicit `--project` binding for Runs and Sessions;
- the selected Live Deck Project room with source-locked native geometry, real
  portraits, bounded native-event previews, and one entry into Conversation
  Detail;
- a first-task composer that creates one durable Run as the current Principal,
  inherits a bound repository and selected personally authorized agent, refreshes
  authoritative Project work, and opens its native live transcript; the
  composer remains a modal surface over its originating Live Deck or
  Conversation Detail rather than reviving a second room shell;
- connected onboarding with explicitly configured `closed|open` external
  registration and separately persisted external identity, repository
  grant/binding, agent connection, and Project selection records; optional
  GitHub App and Google OIDC login/link/invite use PKCE, sealed provider-bound
  state, sealed server-side credentials, and opaque browser sessions;
- personal Lobby selection remains independent of optional Project repository
  governance, so GitHub-backed and unbound local Projects can be selected
  together; an `administer` grant may atomically import one repository as a
  provider-governed Project without fabricating membership;
- high-entropy, digest-only, expiring and revocable Principal invitations whose
  redemption is atomic with identity binding and browser-session issuance;
- exact per-delegator private GitHub checkout authority, revalidated immediately
  before workspace preparation from that person's own grant and credential and
  released before the agent starts;
- a 45-second provider-neutral PresenceLease with 15-second Board heartbeat,
  client-scoped reconnect identity, best-effort release, and expiry filtering;
- a truthful local Project Lobby that composes existing Project reads and enters
  Live Deck without creating another lifecycle or activity store;
- a provider-neutral repository directory plus a tested GitHub App directory
  adapter that normalizes effective repository access as watch, participate, or
  administer without persisting provider credentials;
- exact v0.1.3, Project-Watch-to-current, and intermediate migrations through
  Relay, Annotation, connected onboarding, PresenceLease, identity credentials,
  and Principal invitations with unknown-schema refusal;
- HTTP integration coverage for shared visibility, attribution, denial,
  membership/grant removal, provider-derived access, repository import, and
  browser-session revocation.

The executable collaboration-system proof covers the full technical matrix:
three distinct Principals, separate connected onboarding, independent Presence
leases, exact-range Annotation, addressed Relay acknowledgement, non-member
isolation, credential rotation, member removal, restart, backup, restore, and a
live Board BFF process. Its presentation receipt binds both the selected Live
Deck and Conversation Detail source assets rather than the retired Project Watch
frame. A fresh receipt
passes and verifies against the current dirty worktree after the selected Live
Deck and Conversation Detail changes. This is current development-system
evidence, not clean-revision release evidence and not evidence that two real
people in different locations used one deployed Live Deck. The same proof must
pass with `--require-clean` on the released revision; external acceptance then
remains the human product boundary.

The deployed two-Principal proof is the next narrower gate. Against separate
HTTPS API and Board origins, two persistent member credentials each
delegate a deterministic Run, observe both Runs, open the other conversation,
and fail to control the other delegator's work. Its receipt explicitly records
`externalHumanAcceptance: not_claimed`; replacing humans with credentials or
browser sessions must never silently upgrade that claim.

A fresh development receipt now passes this deployed-system matrix through two
temporary, independently addressed HTTPS origins and verifies against the
current dirty revision. It additionally proves independent secure browser
sessions, connected onboarding, independent Presence leases, one exact-range
Annotation visible to the other Principal, and one addressed Relay through
acknowledgement. The temporary ingress
was removed after verification. This closes the automated topology path but
does not satisfy the clean-revision gate, credentialed live-agent gate, or
two-person acceptance.

## Current Board experience

The implemented surface now carries the selected decisions into the real
member journey:

- the Board opens in connected onboarding, then a Project Lobby showing
  authoritative work and only unexpired lease-backed online people;
- entering one table opens the Live Deck rather than jumping directly into one
  task detail;
- the deck keeps simultaneous human-agent work spatially legible without
  introducing Kanban semantics or a generic dashboard;
- shared work stays visible even when no item needs attention;
- completed, active, and ready work never claims that it needs its delegator;
- failed and timed-out work attributes attention to the delegator without
  assigning it to another viewer;
- the empty Project offers the same self-delegation path as a populated room;
- the composer shows the immutable custody boundary before acceptance and uses
  only public Run contracts rather than a Board-owned task lifecycle; cancel
  restores the originating surface and accepted creation opens the new Run's
  authoritative conversation;
- task detail shows durable delegator attribution, authoritative condition,
  trustworthy timing, and the live ordered conversation;
- protocol sequence numbers never become the interface: user and agent messages
  form the thread, while consecutive working notes and tool calls compose one
  foldable work group;
- the reading surface stays bounded, human prompts remain compact, agent prose
  owns the main plane, and context-gathering tools collapse into one disclosure;
- working notes and tool calls remain foldable while readable agent text streams;
- live following yields when the reader scrolls away and resumes only through an
  explicit return to the latest moment;
- a human can Relay one exact transcript moment to another Project member, and
  the recipient sees it as personal attention until acknowledging it;
- exact transcript text can carry Project-visible marginalia whose source anchor
  remains visible in the vertical progress rail;
- the Board remains physically isolated from the control plane and consumes
  only public client contracts.

Closed registration retains the operator CLI journey: the operator creates the
person Principal and optional explicit membership, then may issue a single-use
invitation through the public API/SDK/CLI. Open registration creates only the
stable person Principal inside the configured Owner; Project access still comes
from explicit membership or a current matching GitHub grant. Meanwhile does not
deliver invitations or let an external subject choose an Owner.

## Decisions already safe to lock

These are product invariants supported by the original intent and current
control-plane architecture:

1. **Project is explicit.** Shared visibility is selected by a durable Project
   relationship, never inferred from repository URL, branch, folder, or agent.
2. **Execution remains truth.** A visible work item is a projection of a `Run`
   or `AgentSession`; Meanwhile does not create a second mutable task lifecycle.
3. **Visibility is broader than control.** Effective Project access may authorize
   reading another participant's work without authorizing cancellation, interruption, input,
   close, deployment, or secret use.
4. **Detail is source-backed, not summary prose.** Conversation, status,
   outputs, and source context remain traceable to durable authoritative
   records without making `evidence` a separate UI concept.
5. **Identity survives credential rotation.** A displayed delegator cannot be
   an API-key ID or key prefix.
6. **The Board remains a reference client.** Authorization, identity, and
   lifecycle ownership stay in public control-plane contracts; the Board owns
   no SQL or hidden execution path.
7. **The execution stack stays fixed.** Project collaboration and repository discovery must not alter
   Run, Session, Runtime, Artifact, or Deployment lifecycle ownership.

## Locked architecture decisions

| Concern | Decision | Record |
| --- | --- | --- |
| Product home | Connected Onboarding → Project Lobby → Live Deck → Conversation Detail | ADR 0009 |
| Identity and tenant | stable Principal; Project contained by Owner | ADR 0001 |
| Capabilities | member read; maintainer membership; original delegator control | ADR 0002 |
| Browser authentication | opaque session in Board HttpOnly cookie; deny-by-default, exact self-Run, onboarding, presence, Relay, and Annotation writes | ADR 0003 + 0006 + 0008 + 0009 |
| Aggregation | authoritative Project work polling; native task events for detail | ADR 0004 |
| Schema transition | additive companion tables; exact v0.1.3 offline migration | ADR 0005 |
| Transcript and handoff | native event follow; foldable details; addressed Task Relay | ADR 0006 |
| Repository-backed discovery | optional provider-neutral directory; GitHub App adapter; Meanwhile retains lifecycle authority | ADR 0007 |
| First-task journey | exact browser self-delegation and self-cancellation; native Run remains truth | ADR 0008 |
| Presence | expiring client-scoped lease; membership never implies online | ADR 0009 |
| Marginalia | exact source-anchored Project Annotation; addressed Relay remains distinct | ADR 0009 |
| External authorization | linked Principal identity; sealed OAuth/OIDC state and credentials; JIT checkout only | ADR 0010 |
| Provider-derived Project access | explicit open/closed registration; repository import; request-time effective access; per-delegator checkout | ADR 0011 |

Browser sessions remain deny-by-default; ADR 0008 adds exact one-shot Run
creation and delegator-authorized cancellation to the Relay writes from ADR
0006. Generic comments, mentions, explicit operator grants, and a durable Project
activity journal remain deferred. They require their own user journey and
durable contract rather than optional fields in this slice.

## Product-form decision

### A. Project Lobby into Project Watch — historical selection, superseded by ADR 0009

The Lobby answers which Project tables the current identity may enter and which
of them are live or need that person. It shows durable members and authoritative
work rather than pretending membership is presence. Entering a table opens
Project Watch.

The home answers two questions in this order:

1. What needs **my** attention?
2. What work is the **Project** carrying?

The shared work list is always visible and dense. Each row leads with task ask,
delegator, agent, execution condition, and last trustworthy update. A detail
sheet or page shows task detail and the ordered conversation. Delegation is
secondary but complete because tasks may originate from Claude Code, Codex, an IDE, chat,
the SDK, or the CLI.

This preserves the strongest part of the current Board while correcting its
single-delegator assumption. The selected desktop composition keeps the shared
inventory visible beside the opened task detail and conversation.

### B. Project Activity

The home is a chronological stream of delegations, agent transitions,
completions, and failures. It makes handoffs and recent changes easy to follow,
but weakens rapid inventory and can make long-running quiet work disappear.

This is a useful secondary view or detail timeline, but a risky primary product
form for “what is everyone carrying right now?”

### C. Mission Board

The home groups work by condition or person and makes the whole Project visible
at once. It is familiar and legible at moderate scale, but easily drifts into
Kanban semantics, manual task movement, assignment, workflow configuration,
and agent operation that Meanwhile does not own.

This remains a useful rejected comparison rather than the primary surface.

ADR 0009 supersedes that historical desktop selection. The approved product
form is **Project Lobby as the entrance, Live Deck as the Project room,
Conversation Detail for the complete source-backed chat, and no Kanban state
machine**. The selected visual target and comparison history are maintained in
the [Shared Project experience brief](project-collaboration-experience.md).
The corresponding ADRs close identity, authorization, browser authentication,
aggregation, and schema migration for this milestone.

## Selected experience contract

This is the selected product contract implemented by the current vertical slice.

### Project Lobby

- only authorized Projects, grouped by a truthful provider account or local
  installation boundary;
- table condition based on native work and pending Relay facts;
- durable member count beside deduped active PresenceLease people;
- an explicit entry into Live Deck;
- watch/participate/administer capability only after the corresponding provider
  and local policy have actually been evaluated.

### Project home

- a clear Project identity and member context;
- one explicit path to delegate a Run as the current person and open it live;
- a viewer-specific Relay address only when recipient semantics are true;
- an always-visible horizontally continuous Deck, defaulting to everyone rather
  than “me”;
- one acrylic card per native task showing the conversation, delegator, agent,
  explicit condition, foldable-work summaries, and source entry;
- a bounded recent-handoff rail projected from Project Relays independently of
  the current viewer's pending inbox;
- one unambiguous path into detail;
- no lifecycle controls for another member's work.

### Work detail

- immutable original ask and delegator;
- current authoritative Run or AgentSession state;
- durable conversation in human reading order;
- live incremental Markdown for readable agent text, with working and tool
  details folded without discarding them and a reader-controlled follow state;
- Project-visible exact-source Annotation marginalia and its progress-rail
  projection;
- addressed Task Relays whose Lobby and Deck attention opens the exact source
  moment, with recipient-only acknowledgement and author receipt;
- artifacts and other safe outputs with source context;
- workspace/revision basis when known;
- timestamps and recovery/cleanup facts when they affect trust;
- an explicit distinction between observation and available control.

### Terminology

Product language should use `Project`, `member`, `delegated by`, `agent`,
`running`, `ready`, `failed`, and `completed`. Internal identity nouns such as
`Actor` or `Principal` should not leak into the UI.

## Architecture decision frame

The implemented architecture is:

```text
Owner or installation tenant
        └── Project
              ├── ProjectMembership ── stable human/service identity
              ├── TaskRelay ────────── human author → recipient + task event anchor
              └── Run / AgentSession ── immutable project + delegator binding
                       └── events / artifacts / deployments inherit access
```

This shape preserves a hard tenant boundary and avoids copying mutable Project
labels onto every derived resource. The stable identity record is `Principal`;
the UI renders its display name as a person or service, never the internal noun.

The authorization chain must eventually prove:

```text
authenticated credential or browser session
  → stable identity
  → tenant boundary
  → active Project membership
  → authoritative work-to-Project relationship
  → capability for this operation
```

Inaccessible resources should continue to return no existence signal. Project
membership removal must affect new reads and long-lived streams, not merely UI
navigation.

## Technology selection

No new framework is justified by the collaboration milestone.

### Deployment neutrality

Friendly open source does not imply one privileged deployment topology. The
same shared-Project product and control-plane contracts must remain viable for:

- a local single-machine installation;
- a user-operated server on a private network;
- a container or VM in private or public cloud infrastructure;
- an optional managed Meanwhile service.

These forms share one API, authorization model, durable evidence model, data
ownership contract, and Project experience. Packaging, ingress, identity
integration, storage, and runtime placement may vary behind explicit adapters;
they must not create separate product semantics. Definition Gate does not
require every topology to ship simultaneously, but it must reject identity,
browser-auth, storage, or event contracts that make another legitimate
topology impossible.

### Keep

- **Bun + strict TypeScript** for the application runtime and contracts;
- **Hono + Zod/OpenAPI** for authenticated Project resources;
- **SQLite WAL** for identity, membership, attribution, and any durable replay
  contract selected later;
- **React in the isolated `board/` workspace** for the reference experience;
- **SWR** for authoritative list/detail snapshots;
- **Zustand or a smaller local reducer** only for live presentation state;
- **conditional polling** for the authoritative Project work list and native
  **SSE/event pagination** for task detail when continuous follow is needed.

### Do not add yet

- WebSocket presence or collaborative cursors;
- CRDTs, Redis, a message bus, or a workflow engine;
- Next.js or another server framework;
- a second task table or UI-owned status model;
- JWT solely to avoid deciding session ownership;
- a generalized policy engine before the capability matrix is known.

### ADR set

The decisions are recorded in `docs/decisions/0001` through `0007`. A later
change to cross-Owner Projects, delegated operator control, browser write
authority, Project activity persistence, or online migration requires a new
ADR because each changes a security or lifecycle boundary.

## Definition Gate completion

The gate closed after all of the following were produced:

1. one approved product brief naming primary user, trigger, job, and non-goals;
2. the Alice/Bob journey and failure cases as a screen-by-screen storyboard;
3. three meaningfully different visual product forms using realistic shared
   Project data, with one selected direction;
4. the selected information architecture for Project home and work detail;
5. an explicit attention semantics table for every Run and Session condition;
6. a capability matrix covering member, non-member, delegator, and operator;
7. ADRs for identity/tenant, browser auth, live aggregation, and migration;
8. an executable two-person acceptance scenario and its negative cases;
9. alignment of AGENTS, README, architecture, threat model, and Board intent.

The first schema/API/Board vertical slice is now implemented. The acceptance
floor below remains stricter than local implementation and must pass before a
collaboration release claim.

The fixed journey, attention hypothesis, mock data, and visual comparison
contract are maintained in [Shared Project experience brief](project-collaboration-experience.md).

## Eventual product acceptance floor

The core visibility release will be complete only when one clean revision proves:

1. Alice and Bob are distinct authenticated people in Project P; Carol is not.
2. Alice delegates a real Run or AgentSession through a supported entry point.
3. Bob sees it appear in P with Alice's durable attribution.
4. Bob opens the authoritative conversation and authorized task outputs.
5. Alice creates one exact-source Annotation that Bob sees at the same anchor.
6. Alice Relays one exact source moment to Bob; Bob finds it from Lobby and Deck
   attention, acknowledges it, and Alice sees the receipt.
7. Bob cannot cancel, interrupt, close, send to, deploy, or otherwise control
   Alice's work through Board, SDK, CLI, or raw HTTP.
8. Carol cannot list, read, stream, or infer the work.
9. Credential rotation, member removal, control-plane restart, backup, and
   restore preserve attribution and enforce current membership.

`bun run proof:project-collaboration` executes the technical matrix through the
public SDK, raw HTTP authorization boundary, production server entry point, and
Board BFF. It writes a self-verifying receipt whose digest covers the
revision, identities, Project/work IDs, authorization denials, browser-session
properties, credential rotation, membership revocation, restart, backup,
restore, credential-absence scan, and selected design reference. The verifier
must be run with `--require-clean --commit=<full-sha>` for an automated
release-candidate claim; external two-person acceptance remains separate.

`bun run proof:deployed-collaboration` then checks the same clean revision
through deployed HTTPS ingress with two pre-provisioned active members. It adds
network and packaging evidence without pretending that two credentials are two
people. Its verifier binds the receipt to the exact clean Git commit.

After that verifier passes, the final human acceptance uses the same clean
revision behind HTTPS ingress. Alice and Bob sign in from separate devices or
networks with separately issued credentials, complete Connected Onboarding,
each delegates through the Board with a credentialed live agent, each opens the
other's Live Deck card and conversation, then share one exact Annotation and one
Relay through recipient acknowledgement and author receipt.
Each participant produces an independent digest-bound attestation; the operator
combines them with the deployed-system receipt. This permits a precise
participant-attested product claim without pretending software verified human
identity. The complete journey, commands, schemas, and claim boundary are in
[External two-person collaboration acceptance](external-collaboration-acceptance.md).

Comments or mentions may extend this proof later; they cannot be required to
claim the shared visibility outcome the user actually asked for.

## Anti-drift rules

- The active milestone is external two-person acceptance and release of the
  clean collaboration-system candidate. The Definition Gate, implementation,
  automated clean-revision receipt, and container packaging are complete; do
  not reopen them through local patches unless external acceptance exposes a
  contract failure that requires a new ADR.
- Do not let an internal noun decide the product model.
- Do not treat `idle`, `failed`, or `succeeded` as a personal attention claim
  without viewer-specific semantics.
- Do not turn the Board into a task tracker or agent operator to make the demo
  easier.
- Do not treat a Project field, multiple API keys, mock data, or two browser
  windows as multi-person proof.
- Keep “implemented,” “locally proved,” “remote proved,” and “released” as
  separate claims.
- Keep automated system proof, participant-attested human acceptance, and
  machine-verified identity as three different claims. The last is not part of
  the current product contract.
- Fact discovery and further Brief expansion remain paused until the Shared
  Project candidate is externally accepted and released; they are neither the
  current product question nor a substitute for two-person use.
