# Good first issue candidates

Draft backlog for `good-first-issue` labels — **not yet filed on GitHub**. Review,
cut what you disagree with, then file the survivors with `gh issue create`. Every
item is a Green-area change per [CONTRIBUTING.md](../CONTRIBUTING.md#where-to-start):
additive behind an existing contract, no control-plane invariant at risk.

Each issue, when filed, should carry: `good-first-issue`, the area label, a link to
the relevant boundary doc, and the acceptance check named below.

## Runtime providers (green — new backend behind `RuntimeProvider`)

1. **Daytona runtime provider.** Implement `RuntimeProvider` against Daytona per
   `docs/provider-contract.md`. Acceptance: passes the shared provider contract
   suite plus a real credential-gated lifecycle test; no provider-name branch in
   the run executor.
2. **Fly Machines runtime provider.** Same contract, Fly Machines backend.
3. **Modal runtime provider.** Same contract, Modal backend.
   > These are each substantial but self-contained. Scope note for newcomers: the
   > shared contract suite already exists and tells you exactly what "done" means.

## Deploy targets (green — new `DeployAdapter` over an immutable source)

4. **Netlify deploy adapter.** Promote a captured artifact to Netlify behind
   `DeployAdapter`. Acceptance: adapter receives only an immutable source (no Store,
   no RuntimeProvider, no owner identity) and has a lifecycle test.
5. **Cloudflare Pages deploy adapter.** Same shape, Pages target.
6. **GitHub Pages deploy adapter.** Same shape, Pages target.

## CLI ergonomics (green — presentation over the public client, `src/cli.ts`)

7. **`meanwhile serve --port/--host` flags** that override the `MEANWHILE_*`
   environment for the local run. Acceptance: covered in `test/integration/cli.test.ts`.
8. **Shell completion output** (`meanwhile completions bash|zsh|fish`). Acceptance:
   generated script is emitted to stdout and snapshot-tested.
9. **Human-readable table output** for `meanwhile list` / `sessions list` behind a
   `--format table` flag (JSON stays the default and machine contract).

## Timeline projections (green — pure functions, `src/timeline.ts`)

10. **Duration summary reducer** that folds a run's events into elapsed
    provisioning/running/total, as a pure projection. Acceptance: unit-tested in
    `test/contracts/timeline.test.ts`; no control-plane coupling. This is groundwork
    for the roadmap's delegator board.

## Documentation & tests (green)

11. **A `providers/` authoring walkthrough** that turns `docs/provider-contract.md`
    into a step-by-step "build your first provider" tutorial ending at the contract
    suite.
12. **Expand `documentation.test.ts`** to also verify that every `console` fenced
    block in the README is syntactically runnable shell (catches broken quick-start
    commands before users hit them).
