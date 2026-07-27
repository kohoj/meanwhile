# Board design QA

## Conversation Detail option 3 — source replica gate

### Comparison target

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

### Findings

No open P0, P1, or P2 visual or interaction defect remains in the accepted
desktop state.

The raw whole-image RMSE is `7991.44 (0.121942)`. It is retained as a diagnostic,
not treated as the acceptance oracle, because both frames intentionally contain
different authoritative dates, elapsed time, annotation count, participant
portraits, and handoff wording. The side-by-side frame is the visual acceptance
artifact for the source-owned surfaces.

### Source-owned surfaces accepted

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

### Product-truth boundaries

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

### Browser evidence

- Path exercised: connected onboarding → Project Lobby → Northstar Live Deck →
  Alice Chen conversation detail.
- Runtime frame: `1487 x 1058`, DPR `1`; index `7`; marginalia landmarks `6`;
  recent handoffs `3`.
- Fold regression: persisted highlight count `1 → 0 → 1` across Reasoning open,
  closed, and reopened states.
- Fresh browser-console errors during the accepted regression window: `0`.
- Reference and implementation were placed together in the same `2974 x 1058`
  comparison artifact before acceptance.

### Automated evidence

- Original acceptance run: `bun run --cwd board check`: `24 pass`, `0 fail`,
  `157` assertions.
- Original acceptance run: `bun run board:journey:check`: `34` checks passed for
  login → onboarding → repository import → Lobby → room → detail → annotation →
  Relay → delegation.
- Original acceptance run: `bun run check`: `390 pass`, `1` explicit
  credentialed Cloudflare live skip, `0 fail`, `2043` assertions across `75`
  files.

### Comparison history

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

## System-wide design-token pass

### Comparison target

- Source visual truth: the authenticated pre-change product captures
  `/Users/kohozheng/.codex/visualizations/2026/07/27/019fa23c-085b-7020-a395-ef4cf153b718/typography-audit/01-before-lobby.jpg`,
  `02-before-onboarding.jpg`, and `03-before-room.jpg`, interpreted through the
  typography contract in `board/PRODUCT.md`.
- Implementation screenshots: `04-after-lobby.jpg`,
  `05-after-onboarding.jpg`, `06-after-room.jpg`, and
  `10-after-conversation-detail.jpg` in the same directory.
- Desktop viewport and pixels: `1487 x 1058` CSS px and `1487 x 1058` image px,
  `devicePixelRatio = 1`; no density normalization was required.
- Mobile viewport and pixels: `390 x 844` CSS px and `390 x 844` image px,
  `devicePixelRatio = 1`; evidence is `07-mobile-onboarding.jpg`,
  `08-mobile-lobby.jpg`, and `09-mobile-room.jpg`.
- State: real authenticated GitHub identity and repositories for Onboarding,
  Lobby, and the empty Project Room; the deterministic internal Board fixture
  was used only to exercise a populated Conversation Detail with transcript,
  annotation, presence, and Relay states.

### Comparison evidence

- Full-view before/after: `11-before-after-lobby.jpg`,
  `12-before-after-onboarding.jpg`, and `13-before-after-room.jpg`.
- Focused typography regions: `14-focus-lobby-hero.jpg` and
  `15-focus-onboarding-content.jpg`. These crops keep both source and
  implementation in one image so family, hierarchy, line height, wrapping, and
  supporting-copy density remain legible.
- Browser-rendered implementation: `http://127.0.0.1:7543/`.

### Findings

- No actionable P0, P1, or P2 finding remains.
- Fonts and typography: the previous fourth family and local size values are
  removed. Newsreader Variable owns display/editorial text, Roboto Condensed
  Variable owns working prose, and IBM Plex Mono owns operational metadata.
  The semantic scale runs from an `11/16` label floor through `15/24` body text
  to responsive display sizes. Supporting prose uses at least `13/20`.
- Spacing and layout rhythm: a shared 4px spatial scale, 8px reading baseline,
  control heights, radii, shadows, motion timings, and z-layers now govern all
  four primary surfaces. Desktop captures preserve the established 10-column
  compositions and show no horizontal overflow.
- Colors and visual tokens: the warm paper, ink hierarchy, rule strengths,
  coral action color, and semantic success/warning/danger colors are centralized
  without changing the product's quiet working-room character.
- Image quality and assets: the live GitHub portrait remains the only human
  portrait source and retains the shared halftone treatment; no placeholder or
  substitute image was introduced. Phosphor remains the single icon family.
- Copy and content: real identity, repository, project, empty state, and
  connected-onboarding copy remain intact. No demo copy was introduced.
- Responsiveness and accessibility: 390px captures have no horizontal overflow;
  persistent mobile actions resolve to a 44px minimum target; focus indicators,
  reduced-motion behavior, semantic controls, and text wrapping remain intact.
- Browser console: checked after Lobby, Onboarding, and Project Room navigation;
  zero warnings or errors were emitted. Development-only React DevTools info was
  the sole console output.

### Comparison history

1. Initial comparison found a P1 typography ownership defect: Inter competed
   with the three product families, and hundreds of local font sizes, line
   heights, weights, and tracking values made hierarchy inconsistent. The fix
   introduced `board/src/ui/design-tokens.css`, removed Inter, and migrated every
   production typography declaration to semantic roles. Post-fix evidence:
   `11-before-after-lobby.jpg` and `12-before-after-onboarding.jpg`.
2. Initial comparison found a P1 readability defect: supporting product copy and
   critical room metadata were frequently rendered at tiny local sizes. The fix
   established the `11/16`, `12/16`, `13/20`, `15/24`, and `17/26` roles and
   promoted supporting prose, empty-state explanation, annotations, and handoff
   copy to the correct semantic level. Post-fix evidence:
   `14-focus-lobby-hero.jpg`, `15-focus-onboarding-content.jpg`, and
   `10-after-conversation-detail.jpg`.
3. The first mobile pass found a P2 accessibility defect: several persistent
   actions computed to 40px. The fix applies the shared 44px target token to
   mobile Project, onboarding, account, connector, and room actions. Post-fix
   evidence: `07-mobile-onboarding.jpg`, `08-mobile-lobby.jpg`, and
   `09-mobile-room.jpg`.

### Primary interactions tested

- Project Lobby → Projects & connections → return to Lobby.
- Project Lobby → Project Room and empty first-delegation state.
- Preview sign-in → connected onboarding → Project selection → Lobby → Live
  Deck → Conversation Detail.
- Responsive relayout at `390 x 844`, including primary actions and sticky
  onboarding completion control.

### Current automated evidence

- `bun run board:check`: `33 pass`, `0 fail`, `224` assertions.
- `bun run board:journey:check`: all `34` end-to-end collaboration checks passed.
- `bun run typecheck`, the complete root `bun test` suite, `bun run lint`, and
  `git diff --check`: passed.

final result: passed
