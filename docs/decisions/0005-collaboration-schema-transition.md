# ADR 0005: Collaboration schema transition

Status: accepted for the first shared-Project release.

## Decision

Collaboration metadata is additive and lifecycle-adjacent:

- `principals` and credential bindings;
- `projects` and active memberships;
- immutable Run and AgentSession Project/delegator binding tables;
- revocable browser sessions.

Run, Session, event, artifact, deployment, and cleanup tables are not rebuilt.
Creation commits the execution row, immutable collaboration binding, initial
event, idempotency record, and audit record in one transaction.

The known `v0.1.3` fingerprint receives one explicit offline migration. It
creates one bootstrap Principal and default Project per Owner, binds every
existing API key to that Principal, enrolls it as Project maintainer, and binds
historical Runs/Sessions to the default Project without changing their bytes or
lifecycle history. Unknown fingerprints still fail closed. Startup never
performs opportunistic migration.

## Rejected

- Discard existing data: it violates the product's durable-history promise.
- Nullable Project fields in lifecycle tables: they create two authorization
  modes indefinitely.
- Automatic startup migration: a failed or interrupted schema mutation should
  not be hidden inside service boot.
