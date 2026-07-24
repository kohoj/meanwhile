# ADR 0006: live transcript and addressed task Relays

- Status: accepted
- Date: 2026-07-23

## Context

Shared Project visibility proves that Bob can open Alice's delegated work, but a
static conversation projection does not yet let him follow a live agent or pass
one precise piece of context back to Alice. A generic comment stream would create
a second conversation product, lose the source moment that caused the comment,
and blur human speech with agent output.

## Decision

Project Watch follows the native Run or AgentSession event stream and reduces it
with the public timeline reducer. User-facing agent text is rendered as streaming
Markdown. Agent working notes, tool calls, plans, usage, and system facts stay
structurally distinct and foldable. The durable event journal remains authoritative;
the Board owns no transcript copy.

The presentation is an agent thread, not an event viewer. User and agent messages
form the readable conversational spine. Context-discovery calls may compose one
foldable phase, while reasoning and later execution or edit activity stay in
separate foldable phases; an individual tool can then expose its bounded input
and output. Provider and journal sequence numbers remain internal ordering and
Relay anchors, never user-facing labels. The projection retains each message or
tool's first and latest durable event occurrence time so the Board can render
chronology without treating runner wall-clock input as authority.
The task opens as a three-part workbench below an always-visible horizontal Room
Pulse: a quiet participant rail, a bounded agent reading column, and a human
handoff margin. The immutable original ask opens the reading column, agent prose
owns its main plane, and completed tool activity is an unboxed disclosure row
rather than an event card. Consecutive read, list,
glob, and search work is summarized as context gathering before the underlying
calls are expanded. A live thread follows new output only while the reader stays
near the latest moment; scrolling away pauses following and exposes an explicit
return-to-latest action.

Introduce `TaskRelay` as an immutable, addressed human handoff:

- one active person in a Project authors it;
- one other active person in the same Project receives it;
- it references exactly one Project-bound Run or AgentSession and event sequence;
- sequence `0` means the immutable original ask;
- all active Project members may read it, but only its recipient may acknowledge it;
- acknowledgement is idempotent and audited;
- a pending incoming Relay is personal attention in Project Watch;
- Relay creation and acknowledgement do not authorize any Run, Session, Turn, or
  Deployment lifecycle operation.

Browser sessions remain deny-by-default. This ADR adds two exact write
capabilities: create a Task Relay and acknowledge a Relay addressed to their
Principal. ADR 0008 separately adds exact self-Run creation and cancellation.
The control-plane route and service enforce these capabilities; the Board BFF
does not invent authorization.

## Consequences

This creates a human transmission loop without comments, threads, reactions,
presence, private messaging, task assignment, or a Project activity journal.
Human Relay notes are projected in the handoff margin while their source moment
remains selected in the transcript; they are never inserted into RunEvent or
SessionEvent. The persistent margin composer carries the selected immutable ask,
work group, or agent message anchor. It is the human handoff counterpart to an
agent composer, not a second agent prompt or a comment box. An acknowledged
Relay renders its durable recipient receipt, never an invented free-form reply.
Existing databases require
the exact offline `migrate:task-relays` transition before running this revision.

If later work needs multiple recipients, private messages, edits, expiry,
escalation, or operator grants, it requires a new contract rather than optional
fields on TaskRelay.
