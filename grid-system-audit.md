# Project Watch grid-system audit

> Superseded as current visual acceptance by the source-replica gate in
> [`design-qa.md`](design-qa.md). This file remains the measured record of the
> preceding Swiss-grid experiment; its product and accessibility findings still
> inform the responsive implementation.

Date: 2026-07-23
Scope: Project Lobby, Project room, live transcript, Task Relay, delegation, and responsive behavior.

## Reference absorbed

The structural source is the Müller-Brockmann grid-system skill supplied by the
user:
`https://raw.githubusercontent.com/alexmcdonnell-airtable/hyperagent-public-skills/refs/heads/main/skill-muller-brockmann-grid-systems.json`.

The implementation adopts its load-bearing rules rather than treating a grid as
an overlay added after composition:

- one token source for content margins, columns, gutters, baseline, and leading;
- the visible overlay and the product layout use the same content box;
- major bands declare explicit column spans and nested bands inherit the parent grid;
- body copy follows an 8 px baseline with 24 px leading;
- display type is optically aligned against the actual loaded font;
- verification measures columns, overlay position, baseline offsets, and ink edges;
- pure white, near-black, neutral gray, and one restrained red replace decorative color noise.

## Meanwhile-specific system

| Width | Grid | Shared content box | Product composition |
| --- | --- | --- | --- |
| `> 980 px` | 10 columns | 24 px margin, 16 px gutter | header `2 / 2 / 3 / 1 / 2`; Room Pulse `2 + 2 + 2 + 2 + 2`; workbench `2 / 5 / 3` |
| `761–980 px` | 8 columns | 24 px margin, 16 px gutter | compact header; Room Pulse remains horizontal; people span full width above transcript `5` and Relay `3` |
| `≤ 760 px` | 4 columns | 16 px margin, 16 px gutter | two-row room header; horizontally inspectable Room Pulse; transcript and Relay become one continuous document |

Typography is bundled rather than host-dependent: Inter Variable owns product
reading and IBM Plex Mono owns metadata and code. The grid inspector is a
keyboard-only development aid: `G` mounts it outside form controls, and closing
it removes both the trigger and guide labels from the product reading order.

## Final refinement pass

The current pass refined the system without changing the product form:

- the Lobby hero and table directory now form one tighter vertical sequence;
- the desktop speaker rail keeps the human and agent together instead of using
  empty height as composition;
- the Relay history and source-anchored composer read as one handoff instrument;
- operational metadata has a 9 px floor, while task and transcript copy retain
  the primary reading hierarchy;
- the phone Room Pulse exposes part of the next task as an intentional
  horizontal-scroll cue and keeps agent names on one line;
- an empty Project has one delegation entry instead of duplicate header and
  empty-state actions;
- the delegation header becomes `Close` while the composer is open, and both
  header and empty-state cancellation return focus to the exact originating
  control;
- one `main` landmark owns each screen, live transcript and task detail use
  named regions, and skip links explicitly focus their target.

Current visual receipts:

- Lobby: `.proof/audit/2026-07-23-deep-polish/22-lobby-final.jpg`
- settled desktop room: `.proof/audit/2026-07-23-deep-polish/24-room-desktop-settled-final.jpg`
- desktop delegation: `.proof/audit/2026-07-23-deep-polish/19-composer-close-final.jpg`
- phone room: `.proof/audit/2026-07-23-deep-polish/20-room-mobile-final.jpg`
- phone delegation: `.proof/audit/2026-07-23-deep-polish/21-composer-mobile-final.jpg`
- measured overlay: `.proof/audit/2026-07-23-deep-polish/18-grid-overlay-after.jpg`

## Flow health

1. **Open the Lobby — passed.** Project identity, room activity, membership, and entry action form one calm hierarchy instead of three unrelated card styles. Desktop: `.proof/audit/2026-07-23-grid-system/28-lobby-1440-final.jpg`. Phone: `.proof/audit/2026-07-23-grid-system/19-lobby-320-polished.jpg`.
2. **Enter a Project — passed.** Project identity, members, delegation, and the complete Room Pulse align to one shared grid with no invented presence semantics. `.proof/audit/2026-07-23-grid-system/26-room-1440-final.jpg`.
3. **Choose and open shared work — passed.** Four task cells retain stable inventory order; selection is one red rule and explicit status text, not a pill or heat map. `.proof/audit/2026-07-23-grid-system/24-room-900-final.jpg`.
4. **Read the live agent transcript — passed.** The original ask, conversational reasoning, foldable tool detail, and streamed agent answer occupy the five-column reading plane; the transcript is no longer an event timeline or title-led hero. `.proof/audit/2026-07-23-grid-system/25-room-1180-final.jpg`.
5. **Pass an exact moment — passed.** Relay stays in the three-column margin, names sender and recipient, preserves the source anchor, and never implies control over the recipient's agent. `.proof/audit/2026-07-23-grid-system/26-room-1440-final.jpg`.
6. **Delegate new work — passed.** Prompt, repository, revision, custody, and actions remain a single readable form. Phone focus no longer scrolls the room identity out of view. `.proof/audit/2026-07-23-grid-system/23-composer-320-final.jpg`.
7. **Use compact layouts — passed.** `900 px` becomes a naturally scrolling document rather than nested clipped panes; `320 px` has no horizontal page overflow and preserves the real seat marks. `.proof/audit/2026-07-23-grid-system/24-room-900-final.jpg` and `.proof/audit/2026-07-23-grid-system/20-room-320-polished.jpg`.
8. **Inspect the system — passed.** The numbered columns and baseline render from the same CSS variables as the application. The `G` shortcut toggles outside form controls and typing `g` inside the delegation prompt does not toggle it. `.proof/audit/2026-07-23-grid-system/27-room-1440-grid-overlay.jpg`.

## Measured acceptance

| Surface | Width | Columns | Max column error | Overlay error | Max baseline offset | Max optical ink error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Lobby | 1440 | 10 | 0.01 px | 0.01 px | 3.5 px | 0.02 px |
| Room | 1440 | 10 | 0.01 px | 0.01 px | 0 px | 0.02 px |
| Room | 1180 | 10 | 0.01 px | 0.01 px | 0 px | 0.02 px |
| Room | 900 | 8 | 0 px | 0 px | 0 px | 0.02 px |
| Room | 320 | 4 | 0 px | 0 px | 0 px | 0.01 px |
| Composer | 320 | 4 | 0 px | 0 px | 0 px | 0.01 px |

Additional checks:

- no horizontal document overflow at `900 px` or `320 px`;
- phone Room Pulse intentionally overflows inside its own scroll container
  (`656 px` content in a `288 px` viewport) while the document itself remains
  overflow-free;
- the settled `1180 × 900` transcript exposes the complete original ask, reasoning, and root-cause answer;
- a fresh navigation plus one full polling interval produced no browser errors;
- the resting DOM contains no grid control or numbered guide content, while
  `G` remains available outside form fields;
- every audited Lobby and Project screen contains exactly one `main` landmark;
- live transcript details fold and reopen; selecting `Root cause` updates the
  Relay source and entering a message enables `Pass this moment`;
- header and empty-state delegation both restore focus after cancellation;
- the smallest rendered product metadata is 9 px;
- bundled fonts remove host-font drift.

## Closed findings

- Decorative bands used different implicit grids and only appeared aligned at one width.
- Warm editorial surfaces and rose fills competed with long-form transcript reading.
- Compact desktop panes clipped text rather than allowing the document to grow.
- The mobile grid trigger overlaid the delegation prompt.
- Mobile prompt autofocus could displace the room identity before the user typed.
- A global `g` shortcut could have interfered with form input without target scoping.

## Acceptance boundary

No known P0, P1, or P2 grid, responsive, reading, or interaction defect remains
in the deterministic local fixture. This validates implemented states and the
measured layout contract. It does not claim full assistive-technology
certification, production GitHub OAuth, deployed multi-person acceptance, or
coverage of every possible agent-controlled Markdown payload.

final result: passed
