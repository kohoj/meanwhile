# Conversation Detail option 3 — source replica gate

## Comparison target

- Source visual truth: `docs/assets/conversation-detail-marginalia-selected.png`.
- Source pixels: `1487 x 1058`.
- Accepted browser implementation:
  `.proof/design-qa/selected-3/implementation-final-1487x1058.png`.
- Same-frame comparison:
  `.proof/design-qa/selected-3/side-by-side-final-1487x1058.png`.
- Pixel difference map:
  `.proof/design-qa/selected-3/diff-final-1487x1058.png`.
- Capture contract: CSS viewport `1487 x 1058`, DPR `1`, complete document
  `1487 x 1058`, normal viewport capture rather than full-page emulation.
- Selected state: Northstar; live Alice Chen and Claude Code task; seven native
  transcript landmarks; Reasoning open; one exact-range Bob Li annotation;
  three Project handoffs; three people online.

The source image owns geometry, material, typography hierarchy, and interaction
placement. Task copy, elapsed time, annotation count, room clock, and handoff
facts remain projections of authoritative records; screenshot text is never
substituted for live data.

## Findings

No open P0, P1, or P2 visual or interaction defect remains in the accepted
desktop state.

The raw whole-image RMSE is `7991.44 (0.121942)`. It is retained as a diagnostic,
not treated as the acceptance oracle, because both frames intentionally contain
different authoritative dates, elapsed time, annotation count, participant
portraits, and handoff wording. The side-by-side frame is the visual acceptance
artifact for the source-owned surfaces.

## Source-owned surfaces accepted

- Exact `81px / 121px / 659px / 197px` vertical composition inside a `1058px`
  desktop document.
- Exact three-column reading-frame ratio `263 / 689 / 480`, `27px` outer inset,
  hairline borders, square editorial geometry, and matching footer placement.
- Restrained warm paper and translucent material cadence with one coral action
  color and low-saturation reasoning field.
- One contiguous code-rendered `16 x 11` signal field with `176` DOM cells and
  zero visual gap. It is not a screenshot, sprite, canvas, or background image.
- Seven transcript-index landmarks with a compact six-point marginalia rail;
  acknowledgement remains readable in the transcript index but does not dilute
  the right-side annotation progress rail.
- Persisted annotation quote is visibly reconstituted as the source red outline,
  with a three-segment connector to the exact right-rail landmark.
- The connector is measured from the authoritative DOM range, reflows on live
  transcript mutation, resize, and scrolling, disappears when its disclosure is
  folded, and returns when reopened. A missing or ambiguous range renders no
  connector rather than a false one.
- Project-level Recent Handoffs remain visible in task detail. Task-local Relay
  state continues to own the annotation card and acknowledgement receipt; the
  footer no longer confuses those two scopes.

## Product-truth boundaries

- The transcript is composed from native Run or AgentSession events and rendered
  with Streamdown; it is not authored to match the screenshot.
- Foldable work remains native `<details>` with real tool, reasoning, test, and
  edit detail.
- Marginalia is a Project-visible source-range annotation. Relay passes that
  exact moment to a named teammate without transferring agent control.
- Long transcripts use count-aware index rows with a readable minimum and local
  scrolling instead of the former hard-coded seven-row compression.
- Room handoffs come from the authoritative Project snapshot; annotations and
  task Relays remain task-scoped.

## Browser evidence

- Path exercised: connected onboarding → Project Lobby → Northstar Live Deck →
  Alice Chen conversation detail.
- Runtime frame: `1487 x 1058`, DPR `1`; index `7`; marginalia landmarks `6`;
  recent handoffs `3`.
- Fold regression: persisted highlight count `1 → 0 → 1` across Reasoning open,
  closed, and reopened states.
- Fresh browser-console errors during the accepted regression window: `0`.
- Reference and implementation were placed together in the same `2974 x 1058`
  comparison artifact before acceptance.

## Automated evidence

- `bun run --cwd board check`: `24 pass`, `0 fail`, `157` assertions.
- `bun run board:journey:check`: `34` checks passed for login → onboarding →
  repository import → Lobby → room → detail → annotation → Relay → delegation.
- `bun run check`: `390 pass`, `1` explicit credentialed Cloudflare live skip,
  `0 fail`, `2043` assertions across `75` files.

## Comparison history

- Pass 1 — blocked: material too dark, active red too fluorescent, and preview
  fabricated a Relay receipt before user action.
- Pass 2 — blocked: desktop geometry converged, but compact widths inherited
  desktop header placement.
- Pass 3 — blocked: corrected height and material lacked a current native-size
  capture.
- Pass 4 — blocked: native-size capture exposed task-scoped footer handoffs,
  hard-coded index density, and missing persisted-anchor visualization.
- Pass 5 — passed: equal-size capture, source geometry, signal continuity,
  annotation outline and connector, Project handoffs, count-aware transcript
  index, fold behavior, and browser console are all closed.

final result: passed
