# ADR 0007: Project Lobby and GitHub-backed repository access

- Status: accepted
- Date: 2026-07-23

## Context

Project Watch proves the inside of one shared Project: members can open work,
follow a live agent transcript, unfold exact working and tool detail, and Relay
one source moment to another person without gaining control of that person's
agent. It does not yet provide the place people arrive before choosing a
Project.

The product metaphor is a game lobby. A repository-backed Project is a table;
Runs and AgentSessions are the live work at that table; a member may watch the
table or participate by delegating their own work. The metaphor explains the
social shape, but the UI must remain an operations product rather than a
skeuomorphic game room.

GitHub already knows which organizations, installations, and private
repositories a person may access. Rebuilding that graph as manually maintained
Meanwhile membership would be worse for GitHub-backed Projects. GitHub does not,
however, know Meanwhile's immutable delegator, agent lifecycle, Relay,
credential-broker, audit, artifact, or cleanup semantics.

## Decision

Add **Project Lobby** above Project Watch:

```text
Project Lobby
  -> provider account or installation
       -> repository-backed Project table
            -> Project Watch
                 -> task detail
                      -> live transcript + folded details + Task Relay
```

The canonical nouns remain `Project`, `Run`, `AgentSession`, `Principal`, and
`TaskRelay`. `Lobby` and `table` are product navigation language, not new
execution entities. The Lobby is a read model and never owns another task,
presence, or activity journal.

For GitHub, use a **GitHub App with user authorization**, not a broad OAuth App
or a personal access token. Repository discovery uses the GitHub App user access
token, so GitHub returns only the intersection of:

1. repositories selected for that App installation;
2. permissions granted to the App; and
3. permissions held by the signed-in GitHub user.

The provider-neutral `RepositoryProjectDirectory` contract normalizes that
answer. GitHub's mutable login, organization name, and repository name are
display metadata. GitHub's numeric user, account, installation, and repository
IDs are the stable binding keys.

## Authority split

| Question | Authority |
| --- | --- |
| Who is this external account? | GitHub user identity, mapped to a stable Meanwhile identity |
| Which private repository tables can it discover? | Current GitHub App installation plus user access |
| May it watch or participate at this repository? | Current GitHub grant intersected with local deployment policy |
| Who delegated a Run or Session? | Immutable Meanwhile Principal binding |
| Who may cancel, interrupt, close, or deploy it? | Meanwhile's immutable delegator policy |
| What did the agent emit? | Native durable Run or Session events |
| What was passed to another person? | Immutable source-anchored Task Relay |
| Who owns cleanup, credentials, artifacts, and audit? | Meanwhile control plane |

GitHub authorization therefore replaces manual eligibility for GitHub-linked
Projects; it does not replace the internal authorization system.

## Capability mapping

The first mapping is deliberately monotonic:

| Effective GitHub repository permission | Lobby capability | Meanwhile meaning |
| --- | --- | --- |
| read or triage | `watch` | Read the Project and its authorized work detail |
| write or maintain | `participate` | Watch, create one's own work, and control only that work |
| admin | `administer` | Participate and manage the repository integration subject to local policy |

An upstream capability is necessary but not sufficient. A deployment may
restrict it further. No GitHub permission grants control over another person's
Run, AgentSession, Turn, Deployment, credential, or Relay acknowledgement.

## Identity and tenant shape

`Owner` remains the hard tenant boundary. A GitHub installation is resolved to
one configured Owner context before any Project read. Managed deployments should
default to one Owner per customer installation; self-hosters may explicitly bind
multiple installations to one Owner. Repository discovery must never cause a
cross-Owner SQL read.

A later additive identity migration introduces:

- `ExternalIdentity`: provider plus immutable subject ID mapped to a durable
  person Principal in one Owner;
- `ProjectRepositoryBinding`: Project plus provider installation/account and
  immutable repository ID;
- `ExternalProjectGrant`: Principal, Project binding, normalized capability,
  observed time, expiry, and revocation state.

Existing explicit `ProjectMembership` remains the local/manual grant. Effective
access is the union of an active explicit membership and an unexpired external
grant, evaluated inside one Owner. Provider removal invalidates the external
grant; it never erases the Principal or historical delegator attribution.

A person authorized across multiple Owners receives separate Owner-scoped
Principal projections. A future Lobby session broker may aggregate their
already-authorized snapshots, but each resource call remains Owner-scoped. The
first GitHub release may require choosing one installation before entering its
Lobby.

## Authentication and credential handling

The browser journey uses OAuth authorization code flow with random `state` and
PKCE S256. The Board BFF may carry the one-time callback, but the control plane
owns the login intent, code exchange, external identity link, grant evaluation,
and issuance of an opaque browser session. Browser JavaScript never receives a
GitHub access or refresh token.

GitHub user tokens are sealed at rest behind an identity-credential vault,
rotated through the refresh-token contract when enabled, and omitted from logs,
errors, SQLite projections, Board responses, and agent environments. A token
may be used transiently by `RepositoryProjectDirectory`; that interface never
returns it.

Private repository checkout is a different credential path. Immediately before
workspace preparation, the control plane obtains a short-lived installation
token through the existing credential-broker boundary. The token never becomes
Run input, runner environment, durable evidence, or an agent-readable secret.

Webhook events for App authorization, installation, organization membership,
and installation repository changes invalidate cached grants. Session issuance
and renewal still revalidate; webhook delivery is an accelerator, not the sole
correctness mechanism. Revocation denies new reads and commands after bounded
revalidation. Already accepted work continues under durable control-plane intent
and cleanup policy, but the removed person cannot continue controlling it.

## Product experience

The Lobby answers, in order:

1. Which Projects can I enter?
2. Which table is live or needs me?
3. Who and what are already there?
4. Am I eligible to watch, participate, or administer?

Entering a table opens the existing verdict-first Project Watch. Entering a task
opens its native live transcript. Human-to-human transmission remains Task Relay:
one person passes one exact transcript moment, plus what the recipient should
carry forward. It does not become chat, comments, or a second agent transcript.

Presence is deferred. Until an ephemeral presence contract exists, the Lobby
shows durable members and authoritative active work, never fake "online" people.
The first UI exposes a truthful Lobby for existing local Projects. GitHub account
grouping appears only after the external identity and Project binding path is
actually connected.

## Delivery slices

1. **Implemented in this change:** local Project Lobby read model and navigation;
   current Project Watch, live transcript, foldable details, and Relay remain the
   table interior; provider-neutral directory contract; GitHub directory adapter
   with permission mapping, bounded installation concurrency, safe pagination,
   and credential-redaction tests.
2. **Implemented in ADR 0008:** a local/manual participant can enter a table,
   delegate a one-shot Run as themselves, retain lifecycle authority, and land
   directly in its native live transcript.
3. **Implemented by ADR 0010:** external identity and repository binding
   migration, sealed identity credentials, GitHub App OAuth/PKCE exchange,
   Owner-scoped browser sessions, and JIT Project-bound repository checkout.
4. **Acceptance next:** GitHub-backed Lobby groups, live provider/revocation
   proof, relink UX, and deployed two-person acceptance.
5. **Implemented by ADR 0009:** an honest ephemeral presence contract that
   grants no control over work delegated by someone else.

## Consequences

The product now has a coherent outside-to-inside path without changing any
execution lifecycle. GitHub can remove most manual membership administration
for GitHub repositories while Meanwhile stays friendly to local, self-hosted,
private-cloud, managed, GitLab, OIDC, and API-key deployments.

This decision rejects GitHub as a mandatory identity provider, repository URL as
implicit authorization, mutable login names as identity, storing provider tokens
in browser storage, treating App webhooks as the sole revocation mechanism,
granting repo writers control of other members' agents, and fabricating presence
from Project membership.
