# ADR 0009: Connected onboarding, Live Deck, and transcript marginalia

- Status: accepted
- Date: 2026-07-24
- Deciders: maintainer
- Supersedes the room-level information architecture in ADRs 0007 and 0008; it does not replace their identity, repository, or first-task boundaries.

## Context

The first collaboration slice proved that Project members can see one another's
delegated work and open a source-backed agent transcript without receiving one
another's lifecycle authority. Its reference client then drifted one level too
deep: Project Watch made one selected task detail feel like the Project room.

The intended product journey is broader and simpler:

1. open the web app;
2. sign in with GitHub or Google, or use an installation-specific local bootstrap;
3. complete onboarding by separately authorizing repository discovery and one or
   more agent connections;
4. select Projects that Meanwhile may surface;
5. enter a Project Lobby of angular frosted-acrylic Project cards;
6. enter one Project room;
7. scan many live human-agent conversations as cards in a Live Deck;
8. open one card into the full source-backed conversation;
9. select exact transcript text and leave Project-visible marginalia whose
   anchors remain visible in a vertical progress rail;
10. use a Relay only when one exact source moment must be addressed to a named
    person and explicitly acknowledged;
11. create personal work from either the Deck or Conversation Detail without
    leaving the room context, then open the accepted Run's native transcript.

Sign-in, repository authorization, agent authorization, Project membership,
presence, annotation, Relay, and run control are different authorities. A single
OAuth token or UI card must not collapse them.

## Decision

### Product hierarchy

The selected hierarchy is:

```text
Connected onboarding
  -> Project Lobby
    -> Project Room / Live Deck
      -> Conversation Detail
        -> foldable agent work
        -> transcript marginalia rail
        -> addressed Relay
      -> contextual one-shot delegation
        -> Conversation Detail for the accepted Run
```

The Live Deck is the Project room. It presents one card per authoritative Run or
AgentSession, with immutable delegator attribution, agent identity, explicit
status text, a bounded conversational preview, foldable-work summaries, and one
entry into the complete conversation. It does not create or copy another task or
conversation lifecycle.

`New task` is not another page or a Board-owned task type. It opens one modal
acrylic work surface over the originating Deck or Conversation Detail, keeps the
room visible as spatial context, and submits through the public Project Run
contract. Cancel restores the exact originating surface and keyboard focus;
acceptance refreshes authoritative Project work and opens the created Run's
native live conversation. The obscured surface is inert while the modal is open.

"Truncate" is presentation collapse only. It may summarize or fold already
authorized transcript material for the card preview, but it never deletes,
rewrites, or replaces durable events.

### Identity and grants

The target onboarding model separates:

- `ExternalIdentity`: a GitHub or Google subject mapped to one stable Principal;
- `IdentityCredential`: a sealed, revocable credential for sign-in continuity;
- `ExternalProjectGrant`: the repositories/projects the provider says this
  identity may discover;
- `ProjectRepositoryBinding`: an explicit local Project-to-repository binding;
- `AgentConnection`: a separately authorized agent/runtime connection with
  bounded capabilities;
- the existing Project membership and delegator authority owned by Meanwhile.

Project Lobby selection is personal visibility, not repository governance. A
person may select any Project they already belong to, including an unbound local
Project, even when the same identity also has GitHub repository grants. An
optional Project-to-repository binding is shown separately and may be changed
only by a Project maintainer using an `administer` grant. Onboarding readiness
therefore requires an agent connection plus at least one selected Project; it
never requires every selected Project to impersonate a GitHub repository.

GitHub is an optional identity and repository authorization provider, not the
Meanwhile tenant boundary or run-control authority. Google may establish the
same Principal but grants no GitHub repository access. Local API-key bootstrap
remains viable for self-hosted and offline installations.

### Presence

Online state is not inferred from membership, recent work, or an open browser
session. The target contract is an expiring `PresenceLease` scoped to
`(owner, project, principal, client)` with heartbeat, expiry, and provider-neutral
storage. Until that contract is implemented, production UI may truthfully show
only the current connected viewer. Deterministic visual fixtures may name their
simulated participants but must not be described as deployment proof.

### Transcript marginalia

An annotation is Project-visible shared marginalia, not a second chat. Its
durable anchor must include:

- task kind and ID;
- authoritative event sequence and, where available, message/block identity;
- exact selected quote plus bounded prefix and suffix;
- UTF-16 start/end offsets for browser reconstruction;
- a digest of the anchored source text;
- author Principal, body, creation time, and optional resolution state.

The UI resolves the anchor against the exact digest first, then bounded quote
context. An unresolved anchor remains visible as detached marginalia rather than
silently moving to different text. The right progress rail is a projection of
annotation positions over the complete transcript, not its own ordering or
storage system.

`TaskRelay` remains distinct: it is addressed, acknowledgement-bearing, and
used to transfer custody of one source moment to one person. Annotation is
ambient Project-visible commentary. Neither grants agent lifecycle control.

Relay attention is a projection of that same durable fact at three levels. The
recipient's Lobby names how many Relays are waiting, the matching Live Deck card
states `Passed to you` without changing task status or inventory order, and
Conversation Detail opens the exact source anchor with the sender's carried
note. Only the named recipient can acknowledge it. The author sees the resulting
acknowledgement on the original conversation. These are not copied messages,
notification rows, or another activity stream.

### Visual target

The selected Project-room target is the generated **Live Deck** source at its
native `1487 x 1058` pixels. It uses a quiet pearlescent full-bleed surface,
angular translucent cards, one restrained tone per agent conversation, real
portrait assets, code-rendered contiguous signal cells, and a bottom room rail.
The target is a visual contract; the implementation may not embed the target
screenshot as runtime UI.

## Consequences

- Project Watch's master-detail Room Pulse is no longer the selected Project
  room. Its native transcript and Relay work remain reusable inside Conversation
  Detail.
- Lobby, Room, and Conversation Detail become distinct navigable states with
  preserved context and deliberate transitions.
- The control plane still owns authorization and durable facts; the Board owns
  only composition, streaming projection, selection, and interaction.
- Presence is an explicit provider-neutral 45-second lease with 15-second Board
  heartbeat, client-scoped reconnect identity, active-list expiry filtering, and
  best-effort release. Multiple client leases collapse to one visible person but
  remain independently recoverable. It grants no authority beyond membership.
- Annotation persistence, authorization, audit, SDK, migration, selection,
  source reconstruction, and marginalia projection are implemented.
- The Relay recipient path is implemented from Lobby attention through Deck
  focus, exact source opening, recipient acknowledgement, and author receipt.
- Connected-onboarding persistence and the local API-key bootstrap journey are
  implemented. ADR 0010 adds optional GitHub/Google OAuth/OIDC with PKCE, sealed
  identity credentials, grant revalidation, and Project-bound private checkout.
  Webhook invalidation and live-provider acceptance remain future work.
- No `evidence` navigation concept is introduced. Logs, events, artifacts, and
  audit records remain system facts surfaced inside the relevant task detail.
- Local, self-hosted, private-cloud, public-cloud, and optional managed
  deployments share the same product and authorization semantics.
- Mixed local and GitHub-backed Projects can coexist in one personal Lobby.
  Selection exposes neither a repository binding nor wider membership, and a
  non-maintainer sees an existing binding as read-only context.

## Delivery sequence

1. Live Deck room and source-locked visual QA.
2. Conversation Detail extraction from the former Project Watch workbench.
3. Durable Annotation contract and progress-rail reconstruction.
4. ExternalIdentity, repository binding, agent selection, and local-bootstrap onboarding.
5. PresenceLease and multi-client expiry/reconnect proof.
6. GitHub/Google OAuth/OIDC, sealed credentials, and private checkout authority
   (implemented by ADR 0010).
7. Fresh clean-revision system proof and external two-person HTTPS acceptance.
