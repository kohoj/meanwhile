# Project Watch interaction polish audit

> Superseded for current visual acceptance by
> [`grid-system-audit.md`](grid-system-audit.md). The interaction findings below
> remain valid; screenshots describe the preceding warm editorial skin.

Date: 2026-07-23
Scope: Lobby to Project room, task selection, live transcript, Task Relay, delegation, account, empty Project, ownership, and compact layouts.

## Flow health

1. **Enter from the Lobby — passed.** Project cards expose membership, room activity, and one clear `Enter table` action without inventing GitHub organization or presence facts. Evidence: `.proof/audit/2026-07-23-polish/01-lobby-1280x720-after.jpg`.
2. **Orient inside a Project — passed.** Room Pulse, people, current viewer, task ownership, and states remain visible at once. The selected card has a contained keyboard focus ring. Evidence: `.proof/audit/2026-07-23-polish/12-own-run-focus-fixed.jpg`.
3. **Read the live agent conversation — passed.** The original ask, reasoning, nested tool work, streamed answer, run facts, and follow recovery occupy one Codex-like transcript column. `Jump to latest` cannot overlap the human handoff margin. Evidence: `.proof/audit/2026-07-23-polish/03-follow-paused-1280x720-after.jpg` and `.proof/design/2026-07-23-brand-recalibration/implementation-1440x1024-polished.jpg`.
4. **Pass an exact moment to another person — passed.** The Relay composer remains source-anchored, recipient-specific, read-only with respect to the other member's agent, and operational after a successful submit. Evidence: `.proof/audit/2026-07-23-polish/08-room-1280x720-final.jpg`.
5. **Delegate new work — passed.** Prompt, repository, revision, custody contract, cancel, and submit controls fit a `1280 x 720` viewport; Escape closes and restores focus. Evidence: `.proof/audit/2026-07-23-polish/09-delegate-1280x720-final.jpg`.
6. **Handle non-happy paths — passed.** Empty Projects explain what will appear and provide the first action; own work uses first-person lifecycle control and neutral self-watching copy; account, Relay, and stop failures stay local and retryable. Evidence: `.proof/audit/2026-07-23-polish/13-empty-project-copy-final.jpg` and `.proof/audit/2026-07-23-polish/12-own-run-focus-fixed.jpg`.
7. **Use the room at phone width — passed.** Project identity is not truncated at `320 x 780`, the page has no horizontal overflow, and the transcript becomes one continuous document. Evidence: `.proof/audit/2026-07-23-polish/06-room-320x780-final.jpg` and `.proof/audit/2026-07-23-polish/07-delegate-320x780-after.jpg`.

## Closed findings

- The follow-recovery control covered Relay input at low height.
- Relay success left the action in a permanent busy state.
- Account and delegation overlays lacked complete dismissal and focus-return behavior.
- Muted labels and status colors fell below the intended reading contrast.
- Low-height delegation hid required source and custody fields.
- Low-height handoff clipped the Relay action.
- Empty-room copy and self-ownership copy were generic or awkward.
- A Room Pulse keyboard outline was clipped by adjacent card borders.
- Settled live output caused the original ask to begin mid-sentence at `1440 x 1024`.

## Acceptance boundary

No known P0, P1, or P2 visual or interaction defect remains in the deterministic local fixture. The pass validates the implemented states and targeted contrast values; it does not claim full assistive-technology certification, production OAuth, deployed multi-person acceptance, or every possible agent-controlled Markdown payload.

final result: passed
