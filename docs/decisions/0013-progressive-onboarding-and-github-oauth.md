# ADR 0013: Repository-gated onboarding and GitHub OAuth

- Status: accepted
- Date: 2026-07-27

## Context

The GitHub App flow implemented after ADRs 0007, 0009, and 0011 made each end
user understand and install a deployment primitive before they could discover
their repositories. That was the wrong onboarding boundary. A person should be
able to sign in with an ordinary GitHub account, approve a familiar OAuth
consent screen, choose a repository, and enter its Project room.

Removing the App-installation step does not remove repository identity from the
product. A Project card without a real repository is a false room: it cannot
state what work belongs there, which GitHub grants confer access, or which local
conversation may be shared into it. Authentication may complete before
onboarding, but the Lobby must not.

## Decision

GitHub authentication uses one ordinary OAuth App configured by the deployment
operator. The authorization request asks for `read:user repo`; the callback
reads `/user` and `/user/repos`, maps GitHub's current repository permissions to
`watch | participate | administer`, and stores the token only as sealed
server-side credential material. OAuth tokens may be expiring with a refresh
token or non-expiring with no refresh metadata. Meanwhile never fabricates
expiry. Every checkout revalidates the exact repository through GitHub before
the token enters the bounded Git helper.

No end user installs a GitHub App. Open external registration is the default so
a previously unknown, verified GitHub subject can atomically receive one stable
member Principal inside the configured Owner. Registration creates identity
only: it creates no Project, membership, or selection. A private deployment may
explicitly choose `closed`.

Connected onboarding is a hard repository gate:

1. GitHub authentication or linking must yield current repository grants. The
   sealed OAuth credential remains the durable authorization; short-lived grant
   rows are a server-side directory cache, not a ten-minute user session. At the
   request-time authorization boundary Meanwhile refreshes an expired directory,
   refreshes an expiring access token when GitHub issued a refresh token, and
   requires OAuth again only when GitHub rejects or can no longer refresh the
   credential. Concurrent refreshes for one identity coalesce and re-read
   current identity state after the gate before deciding whether another
   provider request is still required.
2. An `administer` grant may atomically import its repository as the one
   Owner-unique Project for that immutable GitHub repository ID.
3. A person explicitly selects at least one accessible, repository-bound
   Project before entering the Lobby.
4. Every onboarding Project card displays its authoritative GitHub repository.
   Unbound operator or legacy Projects are never collaboration cards and cannot
   be selected through connected onboarding.

Google OIDC may establish or link the same stable Principal, but it does not
satisfy repository onboarding. The person must additionally link GitHub before
entering a Project room.

Local Companion keeps the same boundary. Browser approval can target only a
repository-bound Project, and the selected local conversation must prove the
matching GitHub origin before any mirror event is accepted.

## Consequences

- A user needs only a GitHub account and the ordinary OAuth consent flow; there
  is no per-user or per-organization App installation step.
- A successful login may remain on connected onboarding until a real repository
  Project is imported and selected. This is deliberate, not a degraded Lobby.
- Repository management exposes search and an explicit GitHub refresh. Reopening
  it from the Lobby is a management state with a route back to the Lobby, not a
  repeated `First entry` ceremony. Provider outage, valid zero-repository access,
  missing linkage, and rejected authorization are distinct visible states.
- `Default Project`, `Personal workspace`, manual repository URLs, and unbound
  Linked conversations are not valid Board product states.
- A Project's immutable repository identity, request-time provider-derived
  access, per-delegator checkout authority, and lifecycle boundaries from ADR
  0011 remain in force.
- OAuth's `repo` scope is broad because GitHub OAuth Apps do not offer
  selected-private-repository read-only consent. A future narrower connector
  may improve consent granularity without changing the Project contract.
