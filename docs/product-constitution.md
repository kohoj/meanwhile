# Meanwhile product constitution

This is the short decision filter for Meanwhile. It distills the controlling
product and engineering specification in [`AGENTS.md`](../AGENTS.md); the two
must change together whenever the product thesis changes.

## Product soul

> **Meanwhile lets people hand work to AI and safely look away.**

The name describes the product: while a person is doing something else,
Meanwhile keeps the delegated promise from becoming lost, ambiguous, or more
powerful than intended.

Meanwhile is the open custody layer for AI-delegated work. It is not merely a
runtime for agents and not a dashboard for watching processes. A person may
hand the work off without handing away its truth, responsibility, or control.

## Human promise

When a person returns, they and their Project should be able to establish:

1. what was delegated and by whom;
2. what is happening now and whether a human is actually needed;
3. what the agent said and produced;
4. what survived a failure, restart, or disappearing runtime;
5. who may observe the work and who may operate it.
6. what another person explicitly passed to them, and whether it was received.

The emotional outcome is calm confidence, not increased supervision.

## Primary product object

The primary product object is **delegated work**: one durable promise made by a
person through an upstream agent, API, SDK, CLI, or future integration.

- `Run` and `AgentSession` are its execution forms.
- `Project` is its shared responsibility boundary.
- Project Lobby is its human entrance; Project Watch is the inside of one
  selected Project table.
- Runtime, agent, and deployment topology are replaceable machinery.
- Events, logs, outputs, and recovery records are source facts inside task
  detail, not a separate `Evidence` product or mode.

## Product laws

### 1. Shared truth

Every active Project member sees the same authoritative work inventory and may
open authorized source-backed detail. Meanwhile never creates a second mutable
task lifecycle to make collaboration easier to render.

### 2. Scoped attention

Project condition and personal attention are different. Healthy work remains
visible but quiet. A failure or request calls only the person who owns the next
decision, while remaining visible to the rest of the Project.

### 3. Retained authority

Visibility does not imply control. Membership may authorize reading another
member's work; only the immutable delegator or a future explicit operator grant
may authorize lifecycle actions.

### 4. Source-backed understanding

The original ask, ordered conversation, outputs, workspace basis, state, and
relevant recovery facts remain tied to durable system records. Presentation may
clarify those facts but never replace them with an unauthoritative summary.

### 5. Safe absence

The system must remain explainable after process failure, control-plane restart,
credential rotation, membership change, or runtime loss. A product that works
only while someone watches it has broken the core promise.

### 6. Deployment-neutral openness

Local, self-hosted, private infrastructure, public cloud, and an optional
managed service use one product, API, authorization, and data-ownership model.
No hosted identity, proprietary service, or deployment topology may become a
semantic prerequisite.

### 7. Addressed handoff

People transmit context through an immutable Relay anchored to the exact task
moment that made it relevant. A Relay names its author and recipient, remains
visible to the Project, and closes only when the recipient acknowledges it. It
never impersonates agent output or grants agent control.

### 8. Qualified entrance

The Lobby shows only Projects the current identity may enter. A provider such
as GitHub may be the upstream authority for repository eligibility, but
Meanwhile remains the authority for immutable delegation, lifecycle control,
Relay, artifacts, credentials, and audit. Provider-backed identity is an
adapter, never a mandatory hosted dependency.

### 9. Quiet by default

Project Watch answers the human question before presenting inventory:

> Is everything fine, or does something need me?

Silence is a valid state. Color, motion, and interruption are reserved for a
real human decision, not agent activity or system vanity.

## Core loop

```text
discover → enter Project → delegate → hold the promise → execute → share truth
         → direct attention → understand source detail
         → accept, recover, or explicitly hand off
```

Every addition must strengthen this loop without moving authority into the
Board, coupling the core to one agent/runtime, or hiding new semantics in an
optional field.

## Current product gate

Shared Project is not released merely because two credentials or browser
sessions work. The active gate is an external two-person journey on one clean
deployed revision:

- two real people use separate personal credentials and devices or networks;
- each enters the shared Project from a truthful Lobby without seeing an
  unauthorized Project;
- each delegates real work through a credentialed live agent;
- each sees, attributes, and opens the other's work within the shared Project;
- each can follow the live source-backed transcript, with agent internals folded;
- one person Relays a precise transcript moment and the other acknowledges it;
- one troubled item produces personal attention only for its delegator;
- the other person sees the same Project condition without being falsely called;
- neither gains controls over the other's agent;
- both report that the shared truth is clear enough to look away and return.

The automated deployed-system receipt proves system behavior. Independent
participant attestations record the human acceptance. Neither may impersonate
the other. The executable protocol is documented in
[`external-collaboration-acceptance.md`](external-collaboration-acceptance.md).

Task Relays are the one explicit human handoff contract, not a comment system.
Until this gate is accepted and released, do not expand into generic comments,
mentions, Kanban, workflow configuration, another runtime provider, ambient memory,
automatic fact discovery, or a separate evidence interface.
