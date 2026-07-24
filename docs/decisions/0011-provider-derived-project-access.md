# ADR 0011: Owner-scoped registration and provider-derived Project access

- Status: accepted
- Date: 2026-07-24

## Context

The selected product journey begins with GitHub or Google sign-in, continues
through repository and agent authorization, and lands in a Lobby of Project
rooms. ADR 0010 required every external subject to map to an already provisioned
Principal and required explicit Project membership for all visibility. That
made the public journey depend on out-of-band operator work and left GitHub
repository grants unable to admit the same people whose access they described.

Meanwhile must also remain deployment-neutral. A private installation may need
closed, invitation-only identity. A friendly open-source installation may
deliberately allow verified provider users to join one configured Owner. Neither
mode may let a provider subject choose a tenant, gain ambient access, borrow
another person's checkout credential, or control another person's agent.

## Decision

External registration is one explicit installation policy:

- `closed` is the default and preserves pre-provisioned or invited identity;
- `open` lets a verified unknown GitHub or Google subject create exactly one
  stable member Principal inside `MEANWHILE_EXTERNAL_AUTH_OWNER_ID`;
- provider credentials, external identities, browser sessions, and Principals
  remain separate durable entities.

Project authorization is a request-time union, never a copied membership:

1. active explicit membership maps `maintainer` to `administer` and `member` to
   `participate`;
2. an unexpired GitHub grant matching an active Project repository binding by
   provider, installation, and repository contributes its native `watch`,
   `participate`, or `administer` access;
3. the strongest current authority wins, with explicit membership winning an
   equal-access tie;
4. grant expiry, revocation, identity revocation, or Principal disablement
   removes provider-derived access at the next authorization check without
   mutating explicit membership or historical delegator attribution.

`watch` may enter the Lobby and room, read native task conversations and shared
room facts, and publish ephemeral Presence. `participate` additionally may
delegate its own work, annotate transcript text, and send or acknowledge Relays.
`administer` additionally may import an authorized repository as a Project,
change the Project repository binding, and administer explicit local members.
Lifecycle control remains restricted to the immutable original delegator at
every access level.

Repository import is one immediate SQLite transaction. An `administer` grant
either reuses the existing active room for the same installation and repository
or creates a provider-governed Project plus binding, then selects it for the
caller. It does not fabricate `ProjectMembership`. This makes the same room
visible to every Principal with a matching current grant.

Private checkout uses the delegator's own current grant, external identity, and
sealed credential. The binding identifies the shared repository; it is not a
pointer to the room creator's authority. Provider rejection revokes only the
caller's grant. The shared binding remains available to other authorized people.
The token still exists only inside the bounded git preparation path and never
enters browser state, Run or Session input, runtime, agent, transcript, or
artifact.

## Consequences

- GitHub can supply identity, repository eligibility, and familiar permission
  levels without becoming the Owner, Principal, work lifecycle, or audit store.
- Google remains identity-only; a Google user links GitHub before importing or
  participating in a private GitHub-backed room.
- Local Projects, explicit memberships, API-key login, invitations, and closed
  self-hosted deployments remain first-class and do not require GitHub.
- Project participant lists expose effective access and authority source instead
  of misrepresenting provider users as durable members.
- Live provider, clean-revision, credentialed-agent, and two-human acceptance
  remain separate receipts; deterministic fixtures prove none of them.

## Rejected alternatives

- Materializing GitHub access as durable `ProjectMembership`.
- Letting an external subject select or create an Owner.
- Treating sign-in as ambient access to every Project in an Owner.
- Using the binding creator's GitHub token for another person's checkout.
- Revoking a shared Project binding when one person's provider grant disappears.
- Making open registration mandatory for self-hosted installations.
