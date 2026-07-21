# ADR 0001: Project identity and tenancy

Status: accepted for the first shared-Project release.

## Decision

`Owner` remains the hard tenant and data-ownership boundary. A `Principal` is a
stable authenticated person or service inside one Owner. An API key or browser
session authenticates exactly one Principal; credentials never become the
displayed human identity.

A `Project` belongs to one Owner. `ProjectMembership` relates a Principal to a
Project. A `Run` or `AgentSession` receives one immutable Project and delegating
Principal binding at admission. The binding is stored beside the execution
lifecycle so Project collaboration cannot mutate or impersonate Run/Session
state.

The first release has two independent role axes:

- Owner role: `admin` or `member`;
- Project role: `maintainer` or `member`.

Personal and self-hosted installs use the same model with one bootstrap
Principal, one default Project, and one membership. There is no personal-mode
authorization fork.

## Rejected

- API key as person: rotation destroys attribution and shared keys erase people.
- Project spanning Owners: it punctures the tenant boundary across every
  artifact, secret, stream, and backup path.
- Repository as Project: repositories are mutable workspace inputs and are not
  collaboration or authorization boundaries.

## Consequences

Owner IDs remain internal tenant facts. Product UI uses Project, member, and
`delegated by`. Identity creation and credential issuance are owner-admin
operations; normal work visibility follows active Project membership.
