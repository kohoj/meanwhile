# ADR 0002: Project capabilities and work ownership

Status: accepted for the first shared-Project release.

## Decision

Capabilities are explicit and minimal:

| Operation | Active member | Delegator | Project maintainer | Owner admin |
| --- | --- | --- | --- | --- |
| Read Project and members | yes | yes | yes | yes when also a member |
| Read Project work and task detail | yes | yes | yes | yes when also a member |
| Create Run/Session in Project | yes | yes | yes | yes when also a member |
| Cancel/interrupt/send/close existing work | no | yes | no | no |
| Manage Project membership | no | no | yes | yes when also a member |
| Create Principal or issue another Principal's first key | no | no | no | yes |

Project role never changes Run, Session, Turn, Artifact, or Deployment state.
Existing-work lifecycle authority follows the immutable delegating Principal.
Membership broadens observation, not operation.

Every read authorizes the complete chain: credential or browser session →
Principal → Owner → active membership → authoritative work binding. An
inaccessible resource returns `NOT_FOUND`. Removing a membership invalidates
new reads and subsequent stream/poll authorization.

## Rejected

- Every member can operate every agent: visibility would silently become shared
  credential and secret authority.
- A generalized policy engine: the first release has a small stable matrix and
  does not need a policy language.
- UI-only enforcement: SDK, CLI, and raw HTTP must receive the same denial.
