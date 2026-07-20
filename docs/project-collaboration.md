# Project collaboration

This document is the controlling product route for Meanwhile's next milestone.
It distinguishes the implemented single-owner system from the intended shared
Project experience and defines the boundaries that must exist before the
product can claim multi-person collaboration.

## Product outcome

People working on the same Project can see work that any Project member has
delegated to an agent, open one item to read its conversation and durable
evidence, and add an append-only comment or mention. Observing another member's
work never grants control over that agent.

The visible loop is deliberately small:

```text
Alice delegates work
        ↓
the Project shows one shared, live work item
        ↓
Bob opens status, conversation, and evidence
        ↓
Bob comments or mentions Alice without controlling the agent
```

This is the product hook for Meanwhile's durable control plane. It is not a
generic task tracker, collaborative IDE, agent console, or new workflow engine.
Every item on the Project watch is an authoritative `Run` or `AgentSession`,
not a second task record that can drift from execution truth.

## Verified current state

The current source implements the durable execution substrate and a useful
single-owner Board projection, but not the collaboration outcome above:

- authentication resolves one bearer API key to `ownerId` and `apiKeyId`;
- every API key under an owner currently has the same owner-wide authority;
- Runs, AgentSessions, Turns, Artifacts, Briefs, Deployments, events, and audit
  reads are authorized only by `ownerId`;
- the Board server holds one owner API key and lists that owner's Runs and
  AgentSessions;
- task detail can already render durable run/session conversation and evidence;
- there is no Project, stable person identity, membership, role, immutable
  delegator identity, project-scoped query, comment, mention, or member-scoped
  live stream;
- Brief-based evidence reuse is implemented for Runs and Turns, but remains
  owner-scoped rather than Project-scoped.

Therefore `v0.1.3` proves a single-owner reference watch surface. It does not
prove that multiple people can safely share one Project, even if its copy names
teammates or stakeholders.

## First-principles model

### Owner is the tenant boundary

`Owner` remains the hard security and storage-isolation boundary. Project
collaboration happens inside one owner. It must not be implemented through
cross-owner exceptions, shared owner bearer keys, or routes that accept an
owner identity from request data.

### Actor is identity; API key is a credential

An API key can be rotated, revoked, or used by automation, so it cannot be the
durable identity shown beside a delegation or comment. Introduce an owner-scoped
`Actor` and bind every credential to exactly one Actor. The request context must
carry all three facts:

```text
ownerId   hard tenant boundary
actorId   durable person or service identity
apiKeyId  credential used for this request
```

Audit retains both Actor and credential identity so attribution survives key
rotation without hiding which credential performed an action.

An Actor is either a person or a service and has one owner-level role:
`admin` or `member`. An admin provisions Actors and Projects. Any Actor may
rotate its own credentials; only an admin may issue or revoke another Actor's
credentials. Project roles remain independent of owner administration.

### Project is the collaboration boundary

`Project` owns membership and visibility. It does not own compute and it is not
an execution lifecycle. A personal installation uses the same model with one
Actor in one Project; there is no separate personal-mode authorization path.

A Project is also not a repository. One Project may delegate work against
different repositories, bundles, branches, or revisions, and the same
repository URL may appear in unrelated Projects. Every Run or AgentSession
continues to snapshot its exact workspace input independently.

### Work retains its existing lifecycle

`Run` and `AgentSession` gain immutable `projectId` and `delegatedByActorId`
bindings at admission. A Turn records its initiating Actor as well. Project
membership never decides run/session status and does not add a new task state
machine. The existing executors remain the only lifecycle owners.

Artifacts, Deployments, Briefs, logs, and event history inherit Project access
through their authoritative Run or AgentSession relationship. Duplicating a
mutable project label on every derived resource would create authorization
drift.

### Comment is collaboration evidence, not agent input

A `Comment` is append-only and binds Project, work kind, work identity, author,
bounded body, explicit mentioned Actor IDs, and creation time. It belongs to a
separate collaboration journal. It never mutates a Run/Session event, changes
execution status, or silently enters the agent's context.

If a human wants a comment to become work, they must explicitly create a new
Run or Turn. That transition receives its own actor identity, idempotency, audit,
and execution evidence.

Mentions resolve only to active members of the same Project. Display names are
presentation; durable identity and notification routing use Actor IDs.

### Project activity is a reference journal

The shared watch needs one resumable Project stream; opening one SSE connection
per active task is a single-owner prototype, not the final collaboration
contract. Add a contiguous append-only `ProjectActivity` journal that references
authoritative Run/Session events, work admission, comments, and membership
changes. It does not copy full conversations or decide execution state.

When an execution or collaboration transaction changes a Project-visible fact,
the matching activity reference is committed atomically. The Board consumes the
Project stream for inventory and attention changes, then reads native RunEvent
or SessionEvent history when a member opens task detail. This preserves one
execution truth while giving external consumers bounded, cursor-correct Project
fan-in.

## Authorization contract

The first complete contract needs only three Project roles:

| Capability | Observer | Delegator | Maintainer |
| --- | --- | --- | --- |
| Read Project and members | yes | yes | yes |
| Read Project work, conversation, and safe evidence | yes | yes | yes |
| Add comment or mention | yes | yes | yes |
| Create a Run or AgentSession in the Project | no | yes | yes |
| Manage Project membership | no | no | yes |

Existing-work commands are a separate ownership rule, not a broad role grant.
The Actor who delegated a Run or AgentSession may issue its lifecycle commands
through an authorized control client. Another Project member remains
read/comment-only for that work, including when they know the resource ID or
call the raw HTTP API. The Board exposes no existing-work command at all.

Every public resource path must enforce the complete chain:

```text
authenticated credential
  → stable Actor
  → same Owner
  → active Project membership
  → resource belongs to Project
  → requested capability is allowed
```

Returning `NOT_FOUND` for an inaccessible resource remains the default to avoid
existence disclosure.

Member removal must stop new reads immediately and close or re-authorize
long-lived Project streams; authorization only at SSE connection establishment
is insufficient.

## Security consequences in the current source

Adding only `projectId` to the Board would be unsafe. The collaboration kernel
must also close these owner-wide authority gaps:

- API-key creation and revocation require Actor/admin authorization;
- Project members cannot enumerate unrelated Projects inside the same Owner;
- Artifact, Brief, Deployment, audit, log, event, and existing-bundle access
  must follow Project membership rather than owner equality alone;
- idempotency is scoped to the authenticated Actor as well as the owner so two
  members cannot collide on the same client-generated key;
- owner-scoped secret references and repository credentials cannot become
  implicitly usable by every Project member. Non-maintainer secret-bearing
  admission must fail until an explicit Project/Actor grant exists;
- Board authentication must preserve the human Actor. A single omnipotent
  server key shared by every browser cannot provide attribution or isolation.

These are control-plane changes, not UI polish. The Board is the final consumer
of the authorization model, never its substitute.

## Schema transition

Project collaboration changes the durable identity graph. Requiring every
operator to discard `v0.1.3` history would contradict Meanwhile's promise that
intent and evidence survive replaceable infrastructure. Before a collaboration
release, provide one explicit offline upgrade/export-import path from the known
published `v0.1.3` schema fingerprint. Startup must continue to reject an
unknown or mismatched schema; there is no dual read and no opportunistic
backfill during request handling.

The deterministic legacy mapping is:

- each existing Owner receives one default Actor and one default personal
  Project;
- existing API keys bind to that default Actor, preserving their current
  authority until the operator creates narrower Actors and memberships;
- existing Runs and AgentSessions bind to the default Project; their derived
  Artifacts, Briefs, Deployments, events, logs, and audit remain reachable
  through those authoritative relationships;
- historical audit retains the original `actorApiKeyId` and records the upgrade
  provenance rather than fabricating a person who did not yet exist.

The release proof must start from a real `v0.1.3` fixture, upgrade it offline,
verify every durable reference and byte digest, boot the new schema, and prove
backup/restore. Development against a fresh data root is not migration proof.

## Delivery route

Work proceeds through the following gates in order. A later gate does not begin
because an earlier API compiles; it begins only after the earlier user outcome
and its negative authorization cases are proved.

### Gate 0 — route and truth alignment

- Keep this document, `AGENTS.md`, README status, Board intent, and the current
  implementation claims consistent.
- Describe the existing Board as single-owner until the two-person proof passes.
- Freeze Fact discovery, ranking, conflict, supersession, and additional Brief
  expansion. The implemented Brief kernel remains supported but is not the
  active product milestone.

### Gate 1 — durable identity and Project membership

- Add Actor, Project, ProjectMembership, and credential-to-Actor binding to the
  domain, schema, store, HTTP/OpenAPI, SDK, and CLI.
- Bootstrap a personal Actor and Project through the same final model used by a
  team.
- Add the explicit `v0.1.3` offline schema transition described above; never
  weaken startup fingerprint rejection.
- Prove key rotation preserves Actor attribution, role enforcement, member
  removal, owner isolation, restart persistence, and idempotent admission.

No Run or Session lifecycle behavior changes in this gate.

Gate 1 and Gate 2 may be separate development commits, but they are one
indivisible authorization release. Until Gate 2 closes every derived-resource
path, non-bootstrap Actor credentials must not receive broad execution-resource
authority. There is no temporarily shared owner-wide team mode.

### Gate 2 — Project-bound delegated work

- Require immutable `projectId` and delegating Actor identity on new Runs,
  AgentSessions, and Turns.
- Add Project-scoped work list/get/event access without duplicating execution
  state into a second task table.
- Enforce Project authorization across every derived resource and command,
  including raw HTTP calls, not just Board routes.
- Bind Project and Actor identity into idempotency and audit.

This gate is complete only when two Actors in one Project can share visibility
while a non-member in the same Owner and an Actor in another Owner both receive
no existence signal.

### Gate 3 — shared Project watch

- Make the Board choose one Project and authenticate each browser as an Actor.
- Show who delegated each work item and preserve the existing verdict-first
  triage, live recovery state, and detail conversation/evidence view.
- Replace owner-wide list/fan-in behavior with a resumable Project-scoped stream
  backed by the ProjectActivity reference journal, with exact authorization,
  removal, replay, and bounded-load proof.
- Authenticate each browser through an Actor-bound, short-lived, HttpOnly,
  SameSite session or an equivalently narrow server-side mechanism. The public
  control plane remains the authorization owner; the Board never shares one
  omnipotent owner credential among users.
- Keep existing work structurally non-operable from the Board.

The Board remains a reference client over public contracts. No Board-only SQL,
authorization, or lifecycle path is allowed.

### Gate 4 — append-only collaboration

- Add task comments and explicit mentions as durable Project collaboration
  evidence with pagination, replay, owner isolation, and restart persistence.
- Compose comments with execution evidence in task detail without inserting
  them into RunEvent or SessionEvent.
- Do not add editing, deletion, reactions, notifications, or an agent-command
  bridge until the core comment loop proves a real need.

### Gate 5 — two-person product proof and release

One clean revision must prove the complete path using distinct credentials:

1. Alice and Bob are active members of Project P; Carol is not.
2. Alice delegates a real Run or AgentSession in P.
3. Bob sees it appear live and sees Alice as the delegator.
4. Bob opens the durable conversation and authorized artifact evidence.
5. Bob adds a comment mentioning Alice.
6. Bob cannot cancel, interrupt, close, send to, deploy, or otherwise control
   Alice's work through Board, SDK, CLI, or raw HTTP.
7. Carol cannot list, read, stream, comment on, or infer the work.
8. Key rotation, member removal, control-plane restart, backup, and restore
   preserve attribution and enforce the current membership state.

Only this gate permits the phrases “multi-person Project,” “shared team Board,”
or “team collaboration shipped.” Unit tests, a Project dropdown, multiple API
keys under one owner, or two browser windows are not equivalent proof.

### Gate 6 — resume shared execution intelligence

After Gate 5, adapt Brief discovery and reuse to Project authorization. A Brief
inherits the source Run's Project and is not visible or reusable from another
Project by default. Fact discovery, conflict/supersession, and cross-Project
sharing remain separate later contracts.

### Gate 7 — open integration contract

Once the first-party Board proves the public Project APIs, external boards,
IDEs, chat entry points, and governance surfaces can integrate with Meanwhile's
durable execution and collaboration substrate instead of rebuilding it.

## Anti-drift rules

- The current active milestone is Gate 1, not Fact discovery or another runtime.
- A backend primitive advances the roadmap only when it closes the current
  gate's user-visible outcome and negative cases.
- Never mark a phase shipped from copy, mock data, a schema, or a visual demo.
- Keep “implemented,” “locally proved,” “remote proved,” and “released” as
  separate claims.
- When prior memory, README prose, and source disagree, current source plus this
  dated route determine implementation truth; historical documents remain
  provenance, not authority.
- Do not broaden the product into task management, agent operation, ambient
  memory, or cross-owner sharing to make the collaboration demo easier.
