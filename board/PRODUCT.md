# Meanwhile Board — Product Intent

The design brief for the delegator's Waiting-For board. Every visual and
interaction decision traces back to this. (Format follows the ui-skills
`impeccable`/`interface-design` "Intent First" method.)

## Who is this human?

**Not the operator who launched the agents — the person who is *waiting on them*.**

Three faces of one role, "the delegator":

- A **tech lead** who kicked off five agents before standup and now, between
  meetings, glances to see which need her and which are handling themselves.
- A **PM / founder** who asked for a fix and wants to know it landed — without
  reading a terminal or pinging the engineer every hour.
- A **reviewer / on-call** who inherited someone else's running work and must
  tell, in three seconds, whether anything is stuck, unsafe, or on fire.

They are **anxious, interrupt-driven, and low-context**. They did not type the
prompts. They will not run a command. They open this on a second monitor or a
phone between other things. Their emotional state is *low-grade worry*: "is the
thing I handed off actually okay?"

## What must they accomplish?

**Triage, in one glance.** The verb is *reassure-or-flag*. Not "manage", not
"operate" — they can't act here anyway (read-only). The board's entire job is to
answer one question the instant it loads:

> **Is everything fine, or does something need a human?**

Everything else — the list, the detail, the history — serves that one answer.
If the delegator has to *scan and read* to get it, the board has failed.

## What should this feel like?

**Like a calm control room at 3am when nothing is wrong — and an unmissable
alarm the moment something is.** Not a dashboard (dashboards make you work).
Not a task app (they can't do tasks). The nearest real-world objects:

- an **air-traffic strip board** — each strip a live thing, position = state
- a **hospital telemetry monitor** — silence is good; you only look closely when
  a line goes flat or a tone sounds
- a **flight-status board** — you find your row, read one word, leave

Feeling in one line: **"I can look away, because it will grab me if it matters."**

## Product domain (exploration, not features)

- **Domain vocabulary:** delegation, hand-off, custody, open loop, closing the
  loop, "waiting for", standing by, escalation, all-clear, the watch.
- **Color world (the actual scene):** a dark ops room. Instrument glow. Amber
  "needs you". A single clean green "all clear". Red is rare and means *stop*.
  The background is not styled — it recedes so the signals read. No brand color
  competes with status; status *is* the color.
- **Signature (only-this-product element):** the board resolves to a single
  **status line at the top — an "all clear" / "N waiting on you" verdict** —
  before any list. That headline verdict, not a card grid, is the product. The
  list is the drill-down. (Air-traffic boards have this; task apps never do.)
- **Named defaults to refuse** (interface-design demands naming them):
  1. an even grid/list of identical cards → the SaaS template; refused
  2. a coloured left side-stripe on each row → an `impeccable` absolute ban
  3. status shown only as a coloured dot/pill → decoration, not a verdict

## Design consequences (the brief, made systemic)

- **Verdict before inventory.** The top of the page states the one answer
  ("Nothing needs you" / "2 waiting on you") in plain words, sized like it
  matters. The list is secondary and quiet.
- **Attention is the layout.** Rank is by *who-needs-a-human*, not by time.
  Waiting/recovering surface loud and up top; running is calm; closed collapses
  away (it's history, not the watch).
- **Silence is the default state.** A board full of healthy running work should
  look *quiet* — low contrast, no color noise — so the eye rests. Color and
  motion are spent only where a human is actually needed.
- **Read-only is honest, not apologetic.** This is a watch post, not a control
  panel. It never shows a disabled button or a "you can't do this here" — it
  simply presents evidence, like a monitor.
- **No cards-by-reflex.** Rows are strips, not cards. Density is a feature: a
  delegator scanning 20 items needs a scannable list, not 20 padded boxes.
