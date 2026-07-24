# ADR 0010: External identity and Project-bound repository checkout

- Status: superseded in part by ADR 0011; token isolation and checkout revalidation remain accepted
- Date: 2026-07-24

## Context

Connected Onboarding needs optional GitHub and Google sign-in without turning a
provider account into Meanwhile tenancy, Project membership, or agent-control
authority. Private GitHub repositories also need checkout credentials, but an
agent must never inherit the provider token used to prepare its workspace.

These are three different authorities:

1. an external subject proves who completed a provider interaction;
2. a stable Meanwhile Principal and active Project membership decide product
   visibility and lifecycle authority;
3. a current repository grant decides whether one exact Project binding may be
   used for checkout.

Collapsing them would make provider outages or membership changes rewrite
durable attribution and would leak broad repository authority into agent
compute.

## Decision

### Authentication transaction

The Board owns only the browser redirect surface. Its same-origin start route
sets a short-lived HttpOnly `SameSite=Lax` correlation cookie containing the
provider, intent, and a hash of the opaque state. The browser session is also
`SameSite=Lax` so the standard top-level provider callback can reauthenticate a
link operation; every Board write remains separately same-origin checked. The
public login callback accepts only login state. The link callback is a distinct
protected route and must present the same Principal session that started the
transaction. A third public invite callback accepts only invite state created
from a valid single-use Principal invitation. The control plane owns the state
payload, PKCE verifier, nonce, redirect URI, issue/expiry times, provider, Owner,
intent, optional linking Principal, and optional invitation identity. It seals
that payload with AES-GCM and requires an exact provider and redirect match at
callback.

GitHub uses authorization code plus PKCE S256. Google uses authorization code,
PKCE S256, nonce, and signed OIDC identity verification. Provider authorization
hosts are allowlisted by the Board before redirect. The callback consumes the
provider response server to server; no provider token enters browser storage.

### Identity and session

An external subject maps to exactly one active Principal inside the configured
Owner. Login requires an existing link. Linking requires an already
authenticated Principal and fails if the subject is linked elsewhere. Automatic
signup and provider-derived Project membership are rejected.

An owner administrator may issue one high-entropy invitation for an already
provisioned active person Principal. Only its SHA-256 digest and safe prefix are
stored. The Board receives the plaintext through `/join/<secret>`, immediately
redirects to a clean URL, and retains it only in a ten-minute HttpOnly
`SameSite=Lax` cookie. Starting provider authorization authenticates the secret
and seals only invitation/Principal identifiers into state. Callback redemption,
identity linking, credential/grant observation, browser-session issuance, and
audits commit in one SQLite transaction. Replay, expiry, revocation, a disabled
Principal, or an identity already bound elsewhere fails closed without consuming
the invitation or issuing a session.

Invitation intent takes precedence over any existing Board session until the
viewer explicitly keeps that session or completes provider authorization. The
Board never merges identities implicitly and never accepts installation access
as invitation redemption; an API key remains the separate operator-provisioned
local/self-hosted path.

The control plane atomically verifies or creates the identity link, rotates its
sealed credential, records current repository grants, revokes stale bindings,
issues an opaque Meanwhile browser session, and writes audit records. Google is
identity-only and stores no provider access credential. GitHub access and
refresh material is AES-GCM sealed with Owner and external-identity associated
data. Only the opaque Meanwhile session is returned to the Board cookie.

### Checkout authority

A maintainer explicitly binds one `administer` GitHub grant to an existing
Project. The binding freezes provider account, installation, repository, and
URL identity; a repository URL alone grants nothing.

This binding is optional Project governance, not a prerequisite for personal
Lobby selection. Unbound Projects remain valid local/self-hosted rooms and may
delegate against an explicitly supplied public HTTPS repository. The presence
of any GitHub grant must not force unrelated selected Projects to bind to it.

Immediately before preparing a repository-backed Run or AgentSession, the
resolver requires the exact active Project binding, active grant, active
Principal and Project membership,
identity, non-expired credential, and current GitHub directory entry for the
same installation and repository. It refreshes the bounded grant observation,
then returns a preformatted Basic authorization value only as
`MEANWHILE_REPOSITORY_CREDENTIAL` to `WorkspacePreparer`. Git uses it as an HTTP
header without embedding the token in argv or the repository URL. Git output is
exact-value redacted, and a `finally` boundary releases the material before the
runner or agent starts.

Provider rejection or a missing repository revokes the grant and binding and
fails closed. An expired access credential requires explicit relinking. The
current design does not automatically exchange a refresh token because GitHub
refresh-token rotation would require a separate durable intent/recovery
contract across the provider-mutation-before-persistence crash window.

## Consequences

- GitHub and Google remain optional adapters; API-key and self-hosted bootstrap
  paths retain the same Principal, Project, and session contracts.
- One Lobby may contain GitHub-backed and unbound local Projects. Only a
  maintainer with an `administer` grant receives the repository-binding control;
  other members receive read-only binding context.
- Provider tokens never become browser cookies, Run/Session input, runner
  environment, transcript, artifact, or agent credentials.
- Repository authorization is checked at the last responsible moment rather
  than trusted from a stale Lobby projection.
- A new person still needs operator provisioning. The one-time invitation binds
  the selected external identity without handing that person an API key;
  invitation delivery and automatic signup remain outside the product contract.
- GitHub webhooks may later accelerate revocation but cannot replace checkout
  revalidation. Live provider, deployed clean-revision, and two-human acceptance
  remain separate evidence gates.
- Removing the Principal whose provider grant backs a Project binding revokes
  that binding before the credential can be reused.
- Key-version metadata does not imply a decrypt keyring. Operational key
  rotation requires an explicit migration/relink procedure before it may be
  claimed as seamless.

ADR 0011 supersedes the person-provisioning, membership-only access, shared
binding credential, and binding-revocation consequences above. Open
registration may create a stable member Principal, effective Project access is
resolved from membership plus current matching grants, checkout always uses the
delegator's own credential, and revoking one person's grant does not destroy the
shared Project-to-repository binding.

## Rejected alternatives

- GitHub as the tenant or Project-membership database.
- Automatic Principal creation from an unknown external subject.
- A broad OAuth App or personal access token as the default repository model.
- Provider tokens in local storage, readable cookies, Board state, or Run input.
- Passing checkout credentials into the runtime agent environment.
- Trusting a durable grant until its TTL without revalidation at checkout.
- Silent automatic refresh without a crash-consistent rotation contract.
