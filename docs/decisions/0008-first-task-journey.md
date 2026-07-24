# ADR 0008: First-task journey and browser self-delegation

- Status: accepted
- Date: 2026-07-23

## Context

Project Lobby and Project Watch made shared work observable, but the first-use
journey stopped before participation. A new member had to understand an API key,
enter a table labelled as eligible for delegation, leave the browser, create a
Run through another client, and return to watch it. The Lobby promised a room;
the product delivered only a window.

Opening all control-plane writes to a browser credential would erase the
authorization boundary that makes shared Projects trustworthy. Keeping the
Board permanently read-only would make the selected lobby/table product form
false. The smallest coherent capability is self-delegation: create work stamped
with the current Principal and control only that work.

## Decision

The reference journey is:

```text
first visit
  -> establish one deployment-appropriate identity
  -> see only eligible Project rooms
  -> enter one room
  -> delegate one Run as the current person
  -> receive a durable Run identity
  -> open its native live transcript immediately
```

Browser sessions remain deny-by-default. They receive these exact writes:

1. `POST /runs` to create a Run whose Project is authorized from current
   membership and whose delegator is derived from the authenticated Principal;
2. `POST /runs/:id/cancel`, which still passes through delegator-only service
   authorization;
3. Task Relay creation and recipient-only acknowledgement from ADR 0006; and
4. self-revocation of the browser session.

They do not receive Principal, Project, membership, API-key, AgentSession,
Turn, Deployment, provider-test, or arbitrary lifecycle writes. The Board BFF
uses only the public typed client and owns no SQL, alternate run record, status,
or authorization rule. Every cookie-authenticated Board mutation additionally
requires an exact same-origin `Origin` (and, when present, `Sec-Fetch-Site`)
check. The OAuth-compatible `SameSite=Lax` session cookie is defense in depth;
the exact same-origin mutation check remains the CSRF trust boundary.

The first implementation is one-shot Run delegation. A local/manual Project
asks for a public HTTPS repository URL and optional literal revision. The Board
uses one operator-configured default agent; it does not expose a catalog of
choices that may not be installed. The composer shows the custody contract
before submission: who delegates, which room receives the work, who may see it,
and whose lifecycle authority it remains.

Run creation is considered successful only after the control plane returns the
durable Run. The UI then refreshes the authoritative Project-work read model,
selects that Run, and follows its native events. There is no optimistic fake
task and no Board-owned task lifecycle.

## GitHub-backed rooms

This change does not fake a GitHub login or private checkout. ADR 0007 remains
the next identity and repository-binding path. When a room has a real
`ProjectRepositoryBinding`, the composer must inherit that immutable repository
identity and omit the manual URL. Private checkout authority must be issued as a
short-lived installation credential behind the existing broker boundary; no
GitHub token may enter browser JavaScript, Run input, agent environment, logs,
or durable projections.

GitHub establishes the external subject and the current installation/repository
intersection. Meanwhile still establishes the Owner projection, Principal,
Project binding, immutable delegator, lifecycle authority, events, artifacts,
audit, and cleanup.

## Experience

The composer occupies the existing task-detail pane instead of becoming a
generic modal or a separate creation application. Its signature is a custody
handoff, not another form card:

```text
current person -> configured agent
room            -> selected Project
visible to      -> current Project members
control         -> original delegator only
```

The primary room action is `Delegate task`. `Enter table` replaces the
spectator-only `Watch table` label. A first empty room offers the same action.
After acceptance, the new task appears in shared inventory and its live
transcript opens in place.

## Consequences

The local and self-hosted product now has one honest first-task vertical slice.
The hard boundary remains intact because write permission is route-exact and
service authorization derives identity rather than trusting Board input.

The remaining first-use gap is GitHub App authorization, external identity and
repository binding, private checkout brokering, and deployed two-person proof.
AgentSession creation, invitations, presence, comments, and generalized browser
write scopes remain separate decisions.
