# Meanwhile Board — Product Intent

This surface implements the human-facing laws in the
[Meanwhile product constitution](../docs/product-constitution.md): shared truth,
scoped attention, retained authority, and quiet by default.

The design brief for the delegator's Waiting-For board. Every visual and
interaction decision traces back to this. (Format follows the ui-skills
`impeccable`/`interface-design` "Intent First" method.)

## Product boundary and current status

The selected product outcome is the ADR 0009 journey: connected onboarding,
Project Lobby, Project Room as a Live Deck of simultaneous human-agent
conversations, then one full Conversation Detail with foldable work, transcript
marginalia, and addressed handoff. Every person sees only the Projects they may
enter, scans one card per authoritative Run or AgentSession, opens work delegated
by any member, and can pass one exact source moment without controlling another
member's agent. Identity, repository authorization, agent authorization,
Project membership, presence, marginalia, Relay, and run control remain separate
authorities.

The Board now implements connected local-bootstrap onboarding, the Project
Lobby, the selected Live Deck room, and the source-locked Conversation Detail.
The Lobby composes authorized Project reads. The room projects each native task
into a bounded card with immutable delegator attribution, agent identity,
explicit state, conversational turns, foldable-work summaries, and one route
into the complete source-backed conversation. Card truncation is presentation
collapse only; it never mutates or copies durable events. Conversation Detail
implements exact transcript selection, Project-visible marginalia, and the
vertical annotation rail. Streamdown renders readable agent output, and working
notes, tool calls, plans, usage, and system facts remain structurally foldable.
No second task lifecycle, transcript store, or Project activity journal exists.
No production component may recognize a fixture ID or substitute authored demo turns, facts,
annotations, handoffs, durations, or timestamps. Visual previews are projections of the same
native task events and collaboration records used outside the fixture environment.
In team mode each person signs in through an already-linked GitHub/Google
identity when configured, or exchanges their own API key once for a short-lived
opaque browser session. The Board keeps only that session in an HttpOnly,
SameSite cookie. Project membership,
delegator attribution, detail authorization, and lifecycle denial are enforced
by the control plane. `MEANWHILE_API_KEY` remains an explicit local single-user
mode, not a team credential-sharing mechanism. Browser sessions are read-only
by default and receive only route-exact self-delegation, self-cancellation, Task
Relay creation, recipient acknowledgement, connected-onboarding changes,
PresenceLease heartbeat/release, and session self-revocation. Run
creation derives the immutable delegator from the session Principal and Project
access; browser input cannot name another delegator.

External registration is an explicit installation policy. In `closed` mode the
operator uses the public CLI/API to create a stable Principal and issue either
one digest-backed invitation for provider identity binding or a separate
revocable installation key. In `open` mode one verified GitHub or Google
subject creates exactly one stable member Principal inside the configured
Owner; the subject cannot select a tenant or fabricate Project access. An
invitation is accepted only through GitHub or Google; it never merges an
existing Board identity or falls back to an API key. Subsequent visits can use
the linked identity directly. An entered Project can delegate a one-shot Run
through the same public API used by the CLI and SDK. Neither surface invents authorization:
self-delegation, Relay writes, and cross-member lifecycle denial are enforced by
the control plane.

ADR 0007 selects a GitHub App as an optional repository directory; ADR 0009
separates ExternalIdentity, IdentityCredential, ExternalProjectGrant,
ProjectRepositoryBinding, AgentConnection, PresenceLease, and Annotation. The
provider-neutral repository directory, permission normalization, durable
ExternalIdentity/grant/binding records, agent connections, Project selection,
and expiring client-scoped PresenceLeases are implemented. Local bootstrap now
runs the full onboarding-to-first-task path; a bound repository and selected
agent flow into delegation without browser-held repository credentials.
ADR 0010 implements GitHub/Google OAuth/OIDC with PKCE, sealed
IdentityCredential storage, exact login/link callback boundaries, grant
revalidation, one-time Principal invitation binding, and Project-bound private
checkout material released before the agent starts. ADR 0011 adds configurable
open registration, atomic repository import, request-time provider-derived
Project access, participant projection, and per-delegator checkout authority.
Provider webhook invalidation, invitation delivery, and live-provider
acceptance remain unimplemented.
Online state is derived only from active PresenceLeases, never membership. The
Northstar three-person state is an explicit deterministic lease fixture.

Project selection is a personal Lobby preference and stays independent from
Project repository governance. GitHub-backed and unbound local Projects may be
selected together. Only a Project maintainer with an `administer` repository
grant or a current provider-derived `administer` participant may bind or replace
a Project repository; other participants see an existing binding as read-only
context. A GitHub grant never makes an unrelated local Project incomplete and
never becomes durable membership.

Delegation stays inside the room's spatial model. `New task` opens one angular
acrylic modal over the originating Live Deck or Conversation Detail instead of
switching back to the retired Project Watch shell. Cancel restores the source
surface and trigger focus; acceptance refreshes authoritative Project work and
opens the created Run's native transcript. The modal exposes the immutable
Principal → agent custody boundary before submit and makes the underlying room
inert while it owns focus.

That accepted transcript must belong to the created Run in time and meaning.
Every displayed Agent event occurs after the Run's acceptance instant, and a
deterministic preview may not borrow another task's conversation merely to make
the new detail surface look populated.
Card and detail projections may request the same history concurrently. They share one in-flight
authoritative read, and every successful detail hydration establishes its follow stream from the
returned cursor; an existing card request must never cause detail to skip live updates.
Plain-text summaries may remove Markdown chrome, but must preserve engineering vocabulary such
as `invalid_grant`, glob patterns, paths, and code identifiers exactly.

## Who is this human?

**Not the operator who launched the agents — the person who is *waiting on them*.**

Three faces of one role, "the delegator":

- A **tech lead** who kicked off five agents before standup and now, between
  meetings, glances to see which need her and which are handling themselves.
- A **PM / founder** who asked for a fix and wants to know it landed — without
  reading a terminal or pinging the engineer every hour.
- A **reviewer / on-call** who inherited someone else's running work and must
  tell, in three seconds, whether anything is stuck, unsafe, or on fire.

In the Project surface these are distinct authenticated people, not
different personas sharing one owner credential.

They are **anxious, interrupt-driven, and low-context**. They did not type the
prompts. They will not run a command. They open this on a second monitor or a
phone between other things. Their emotional state is *low-grade worry*: "is the
thing I handed off actually okay?"

## What must they accomplish?

**Triage, understand, and hand off precisely.** The first verb is
*reassure-or-flag*. The Board is not a generic agent console: it can put the
current person's one-shot work on a table and stop that work, but it owns no
agent lifecycle or cross-member controls. Its first job is to
answer one question the instant it loads:

> **Is everything fine, or does something need a human?**

Everything else — the list, the detail, the history — serves that one answer.
If the delegator has to *scan and read* to get it, the board has failed.

When reading uncovers something another person must carry, the user can Relay
that exact transcript moment to them. This is not a parallel chat: it is a
source-anchored handoff to one named Project member. The sender must write the
thought, decision, or question that travels with the source; the interface never
silently chooses a recipient or generates human intent. An explicit
acknowledgement receipt closes the loop. The receipt is the durable Relay fact;
the interface never fabricates a human reply.

The handoff must be legible from both sides. Before opening a task, the named
recipient sees `Passed to you` on the Project card and the card becomes the
initial Deck focus without reordering shared work. Opening it lands on the
anchored transcript moment and presents the sender's carried note beside the
source. Only the recipient can acknowledge. After acknowledgement, the sender's
same source detail changes from `Awaiting acknowledgement` to `Acknowledged`;
no generated chat message or duplicate notification record is created.

The room rail reads the latest Project-visible Relays directly from the Relay
store. It is a bounded read projection, not the recipient inbox and not a
second Project activity journal; acknowledgement never makes a handoff vanish
from the shared recent context.

## What should this feel like?

The Lobby is a quiet shared hall where every door is one real Project and
activity is legible before entry. Inside a room, Meanwhile feels like a shared
live deck: pearlescent light, angular translucent conversation sheets,
recognizable human seats, restrained agent color, and one bottom room rail that
makes co-presence and recent handoff legible without turning the product into a
dashboard.
It is calm enough to read for ten minutes and clear
enough to scan in three seconds. Not a dashboard, task app, terminal skin, or
social feed. The nearest real-world objects are:

- an **editorial contents grid** — shared work stays aligned and always visible;
- a **marked-up working proof** — agent prose is primary, details fold in place;
- a **margin handoff** — one source moment travels with its human note intact.

Feeling in one line: **"We are not in the same place, but we are looking at the
same work."**

## Product domain (exploration, not features)

- **Domain vocabulary:** delegation, hand-off, custody, open loop, closing the
  loop, "waiting for", standing by, escalation, all-clear, the watch.
- **Color world (the actual scene):** warm ivory paper, near-black ink, neutral
  gray structure, and a low-saturation rose signal field. One restrained red is reserved
  for active selection and human action; status remains explicit text and never has
  to be inferred from brand color.
- **Signature (only-this-product element):** `Live Deck` makes simultaneous
  human-agent work spatially legible without converting it into task-manager
  columns. Each angular acrylic card is a truthful projection of one native task;
  contiguous code-rendered signal cells create a quiet agent-specific field.
  Opening a card reveals the full conversation. Annotation remains in the page
  margin; Relay carries one exact source moment to one named person.
- **Named defaults to refuse** (interface-design demands naming them):
  1. an even grid/list of identical cards → the SaaS template; refused
  2. a coloured left side-stripe on each row → an `impeccable` absolute ban
  3. status shown only as a coloured dot/pill → decoration, not a verdict

## Design consequences (the brief, made systemic)

- **One measured composition.** At the selected source's native `1487 x 1058`,
  the room uses an `81px` header, a `61px` Deck label, `713px` conversation
  sheets, and a `129px` bottom rail at `y=913`. The first four card boundaries
  are `26–472`, `484–870`, `882–1243`, and `1255–1641`; horizontal overflow is
  the deliberate continuation cue. Compact layouts preserve one conversation
  per card rather than collapsing the room into dashboard tiles.
- **Typography is deployable product behavior.** Newsreader Variable owns the
  editorial identity layer, Roboto Condensed Variable owns conversational
  reading, and IBM Plex Mono owns code and operational metadata. All three are
  bundled, so line wrapping and density do not drift with the host system.

- **Conversation before management.** Live Deck puts the human-agent exchange,
  not a status dashboard, at the center of every work item. Explicit text still
  carries state and attention; color is only a restrained spatial accent.
- **Attention and truth do not reorder each other.** The Project inventory stays
  stable while personal Relay or failure attention is explicit inside the same
  item and verdict. Healthy and completed teammate work remains visible.
- **Silence is the default state.** A board full of healthy running work should
  look *quiet* — low contrast, no color noise — so the eye rests. Color and
  motion are spent only where a human is actually needed.
- **Non-operational is honest, not apologetic.** This is a watch post, not a
  generic agent console. It presents source detail, supports self-delegation and
  self-cancellation, and enables precise human Relay handoffs; another member's
  lifecycle controls never appear.
- **Cards are the room's spatial primitive, not generic containers.** One card
  equals one live human-agent conversation and preserves its delegator, agent,
  state, turns, and foldable-work summaries. Density is handled through a
  horizontally scrollable deck and disclosure rather than dashboards or manual
  workflow columns. Phone layouts reveal part of the next conversation as the
  scroll cue. An empty Project exposes one first-delegation action.
