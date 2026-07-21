# Shared Project definition

This document is the controlling product and acceptance contract for
Meanwhile's Shared Project milestone. The Definition Gate is closed: Project
Watch and ADRs 0001–0005 are selected. The implementation status and remaining
proof boundary are recorded here rather than hidden behind UI claims.

## Why the route is now fixed

The route was paused until product form, attention semantics, identity,
authorization, browser authentication, aggregation, and migration were chosen
together. Those choices are now explicit: Project Watch, stable Principals,
Owner-contained Projects, two small role axes, delegator-only lifecycle
authority, opaque read-only browser sessions, polling plus native task events,
and an additive migration from the exact v0.1.3 schema.

## Product north star

> In one shared Project, every member can see work delegated by every other
> member, understand its current condition at a glance, and open its task
> detail and conversation without gaining control over somebody else's
> agent.

The smallest proof is:

```text
Alice delegates work through an upstream agent, API, SDK, or CLI
        ↓
Project P shows the work live and attributes it to Alice
        ↓
Bob opens it and reads the prompt, conversation, outcome, and available outputs
        ↓
Bob cannot issue lifecycle commands against Alice's work
```

Comments, mentions, presence, reactions, task assignment, workflow columns,
agent orchestration, and editing are not part of this acceptance floor. They
remain later product questions rather than hidden requirements.

## Implemented current state

The source now implements:

- API keys bound to stable person/service Principals inside one Owner tenant;
- Projects, active membership, maintainer/member roles, and member management;
- immutable Project and delegator bindings on Runs and AgentSessions;
- Project member reads of work, task conversation, artifacts, Briefs, and
  deployments, with current membership checked at access time;
- delegator-only Run/Session lifecycle commands and deployment creation;
- Principal-scoped Run, Session, and Deployment idempotency;
- opaque expiring browser sessions that are read-only and revocable;
- a typed Project namespace in the public client;
- public CLI commands for Principal, Project, membership, and per-Principal key
  administration, plus explicit `--project` binding for Runs and Sessions;
- the selected Project Watch master-detail Board with per-person login;
- an explicit v0.1.3 offline migration command and unknown-schema refusal;
- HTTP integration coverage for shared visibility, attribution, denial,
  membership removal, and browser-session revocation.

The executable collaboration-system proof covers the full technical matrix:
three distinct Principals, non-member isolation, credential rotation, member
removal, restart, backup, restore, and a live Board BFF process. It passes from
one clean revision and exact-commit verification. This is release-candidate
system evidence, not evidence that two real people in different locations used
one deployed Project Watch. That external acceptance remains the release
boundary.

The deployed two-Principal proof is the next narrower gate. Against separate
HTTPS API and Project Watch origins, two persistent member credentials each
delegate a deterministic Run, observe both Runs, open the other conversation,
and fail to control the other delegator's work. Its receipt explicitly records
`externalHumanAcceptance: not_claimed`; replacing humans with credentials or
browser sessions must never silently upgrade that claim.

## Current Board experience

The implemented surface now carries the selected decisions into the real
member journey:

- verdict-first hierarchy remains calmer and more legible than a generic
  dashboard;
- shared inventory stays visible even when no item needs attention;
- completed, active, and ready work never claims that it needs its delegator;
- failed and timed-out work attributes attention to the delegator without
  assigning it to another viewer;
- the empty Project explains where delegated work comes from instead of showing
  an inert list or a misleading Board-owned launch action;
- task detail shows durable delegator attribution, authoritative condition,
  trustworthy timing, and the ordered conversation;
- the Board remains physically isolated from the control plane and consumes
  only public client contracts.

Member provisioning remains an operator CLI journey. Adding invitations or an
administration UI would create a new write-authority and delivery contract and
is intentionally not hidden inside this read-only milestone.

## Decisions already safe to lock

These are product invariants supported by the original intent and current
control-plane architecture:

1. **Project is explicit.** Shared visibility is selected by a durable Project
   relationship, never inferred from repository URL, branch, folder, or agent.
2. **Execution remains truth.** A visible work item is a projection of a `Run`
   or `AgentSession`; Meanwhile does not create a second mutable task lifecycle.
3. **Visibility is broader than control.** Membership may authorize reading
   another member's work without authorizing cancellation, interruption, input,
   close, deployment, or secret use.
4. **Detail is source-backed, not summary prose.** Conversation, status,
   outputs, and source context remain traceable to durable authoritative
   records without making `evidence` a separate UI concept.
5. **Identity survives credential rotation.** A displayed delegator cannot be
   an API-key ID or key prefix.
6. **The Board remains a reference client.** Authorization, identity, and
   lifecycle ownership stay in public control-plane contracts; the Board owns
   no SQL or hidden execution path.
7. **The execution stack stays fixed.** Project collaboration must not alter
   Run, Session, Runtime, Artifact, or Deployment lifecycle ownership.

## Locked architecture decisions

| Concern | Decision | Record |
| --- | --- | --- |
| Product home | Project Watch master-detail | experience brief |
| Identity and tenant | stable Principal; Project contained by Owner | ADR 0001 |
| Capabilities | member read; maintainer membership; original delegator control | ADR 0002 |
| Browser authentication | control-plane opaque session in Board HttpOnly cookie; read-only | ADR 0003 |
| Aggregation | authoritative Project work polling; native task events for detail | ADR 0004 |
| Schema transition | additive companion tables; exact v0.1.3 offline migration | ADR 0005 |

Comments, mentions, presence, explicit operator grants, and a durable Project
activity journal remain deferred. They require their own user journey and
durable contract rather than optional fields in this slice.

## Product-form decision

### A. Project Watch — selected

The home answers two questions in this order:

1. What needs **my** attention?
2. What work is the **Project** carrying?

The shared work list is always visible and dense. Each row leads with task ask,
delegator, agent, execution condition, and last trustworthy update. A detail
sheet or page shows task detail and the ordered conversation. Delegation is absent
or secondary because tasks may originate from Claude Code, Codex, an IDE, chat,
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

The approved product form is **Project Watch as the primary surface, Activity
inside task detail, and no Kanban state machine**. The corrected reference image
is maintained in the [Shared Project experience brief](project-collaboration-experience.md).
The corresponding ADRs close identity, authorization, browser authentication,
aggregation, and schema migration for this milestone.

## Selected experience contract

This is the selected product contract implemented by the current vertical slice.

### Project home

- a clear Project identity and member context;
- a viewer-specific attention verdict only when recipient semantics are true;
- an always-visible shared inventory, defaulting to everyone rather than “me”;
- optional person and condition filters that do not hide the default proof;
- rows showing task ask, delegator, agent, condition, and last durable update;
- one unambiguous path into detail;
- no lifecycle controls for another member's work.

### Work detail

- immutable original ask and delegator;
- current authoritative Run or AgentSession state;
- durable conversation in human reading order;
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

The decisions are recorded in `docs/decisions/0001` through `0005`. A later
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
5. Bob cannot cancel, interrupt, close, send to, deploy, or otherwise control
   Alice's work through Board, SDK, CLI, or raw HTTP.
6. Carol cannot list, read, stream, or infer the work.
7. Credential rotation, member removal, control-plane restart, backup, and
   restore preserve attribution and enforce current membership.

`bun run proof:project-collaboration` executes the technical matrix through the
public SDK, raw HTTP authorization boundary, production server entry point, and
Project Watch BFF. It writes a self-verifying receipt whose digest covers the
revision, identities, Project/work IDs, authorization denials, browser-session
properties, credential rotation, membership revocation, restart, backup,
restore, credential-absence scan, and selected design reference. The verifier
must be run with `--require-clean --commit=<full-sha>` for an automated
release-candidate claim; external two-person acceptance remains separate.

`bun run proof:deployed-collaboration` then checks the same clean revision
through deployed HTTPS ingress with two pre-provisioned active members. It adds
network and packaging evidence without pretending that two credentials are two
people. Its verifier binds the receipt to the exact clean Git commit.

After that verifier passes, the final human acceptance uses the same revision
behind HTTPS ingress. Alice and Bob sign in from separate devices or networks
with separately issued credentials, Bob opens Alice's work and conversation,
and an operator rotates Alice's credential and removes Bob while both clients
are observed. Record the deployed origin, revision, time window, and outcomes;
never put credentials or browser-session secrets in the record.

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
- Fact discovery and further Brief expansion remain paused until the Shared
  Project candidate is externally accepted and released; they are neither the
  current product question nor a substitute for two-person use.
