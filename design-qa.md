# Project Watch design QA

- Reference: `docs/assets/project-watch-selected.png`
- Implementation: `http://127.0.0.1:7333/`
- Comparison viewport: 1487 x 1058
- Browser: Codex in-app browser
- Captured implementation: `/tmp/project-watch-accepted.png`

## Acceptance

- Master-detail hierarchy, column proportions, dividers, warm dark material, serif display type, compact status color, and selected-row treatment match the selected direction.
- Project, member count, current Principal, current-person verdict, and other-delegator verdict remain legible at first glance.
- Task selection updates the inline detail and conversation without navigation.
- Account interaction opens an explicit menu; sign-out is no longer an accidental direct click.
- Internal lifecycle labels are translated into `ready` and `completed` for the product surface.
- Keyboard focus stays visible in the same accent language as selection.
- Browser console produced no warnings or errors.
- Reference and implementation were inspected together at the same viewport after the final fix.

Content, people, and relative timestamps intentionally differ because the implementation was exercised with realistic Project data rather than copied screenshot text. The full-conversation control appears only when the durable timeline exceeds the concise inline view.

passed
