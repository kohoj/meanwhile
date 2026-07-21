# ADR 0004: Project work read model

Status: accepted for the first shared-Project release.

## Decision

The first shared Project surface uses one authoritative Project work endpoint
that joins immutable Run/Session Project bindings with their current lifecycle
rows in one bounded query. The initial contract returns the latest 100 work
items; the Board refreshes that snapshot through periodic polling. Opening
an item reads its native RunEvent or SessionEvent history.

No second task table or stored UI status exists. Attention is a viewer-specific
pure projection over execution facts and immutable delegator identity. The
Project endpoint returns work truth; the client decides presentation buckets.

Polling is deliberately chosen before a Project journal. SQLite remains the
single durable writer, current Project scale is tens rather than millions of
active items, and polling re-authorizes every request after membership removal.
Keyset pagination is the next compatible expansion if Projects exceed this
bounded snapshot. An append-only Project reference stream may replace polling
later without changing the work-item contract.

## Rejected

- BFF fan-in across one SSE connection per task: load scales with active work
  and authorization becomes difficult to revoke coherently.
- ProjectActivity in the first slice: it duplicates write fan-out across every
  execution transaction before replay semantics are proven necessary.
- Kanban/task projection table: it creates a second lifecycle that can drift
  from Run and Session truth.
