# ADR 0003: Browser authentication

Status: accepted for the first shared-Project release.

## Decision

The control plane owns revocable opaque browser sessions. A user exchanges an
API key once over an authenticated Board login request. The control plane
returns a random session credential once, stores only its digest, binds it to
the same Principal and Owner, and applies an absolute expiry.

The Board stores the session credential in an `HttpOnly`, `SameSite=Lax`
cookie and sends it server-to-server as a bearer credential. Lax permits the
standard top-level OAuth/OIDC callback added by ADR 0010 to reauthenticate an
identity-link transaction; every mutation still requires the exact same-origin
Board boundary. No owner-wide API
key is shared among browsers or embedded in browser JavaScript. HTTPS
deployments mark the cookie `Secure`; loopback development uses the same
session semantics without that transport flag.

The initial Project Watch was read-only for existing work. Login, logout, and
all later browser mutations validate the same-origin request boundary. External
login and link additionally use a short-lived `SameSite=Lax` HttpOnly
transaction cookie bound to provider, intent, and a hash of sealed state; link
completion is a distinct authenticated callback rather than a public login
callback.

ADR 0006 and ADR 0008 amend that initial surface with route-exact Relay and
self-Run writes. Every Board mutation now requires an exact same-origin request;
the control plane still derives identity, Project eligibility, and delegator
authority. All unlisted writes remain forbidden.

## Rejected

- One Board server API key for every user: it erases attribution and grants
  owner-wide authority.
- Long-lived API key in local storage: browser script compromise exposes the
  root credential.
- Stateless JWT as the first implementation: immediate revocation, member
  removal, and local deployment are simpler with the existing SQLite authority.
