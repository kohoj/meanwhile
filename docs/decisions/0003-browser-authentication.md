# ADR 0003: Browser authentication

Status: accepted for the first shared-Project release.

## Decision

The control plane owns revocable opaque browser sessions. A user exchanges an
API key once over an authenticated Board login request. The control plane
returns a random session credential once, stores only its digest, binds it to
the same Principal and Owner, and applies an absolute expiry.

The Board stores the session credential in an `HttpOnly`, `SameSite=Strict`
cookie and sends it server-to-server as a bearer credential. No owner-wide API
key is shared among browsers or embedded in browser JavaScript. HTTPS
deployments mark the cookie `Secure`; loopback development uses the same
session semantics without that transport flag.

The initial Project Watch is read-only for existing work, which keeps browser
mutation and CSRF surface intentionally small. Login and logout validate the
same-origin request boundary; later browser mutations require an explicit CSRF
contract rather than weakening the cookie.

## Rejected

- One Board server API key for every user: it erases attribution and grants
  owner-wide authority.
- Long-lived API key in local storage: browser script compromise exposes the
  root credential.
- Stateless JWT as the first implementation: immediate revocation, member
  removal, and local deployment are simpler with the existing SQLite authority.
