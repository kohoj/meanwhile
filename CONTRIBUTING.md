# Contributing to Meanwhile

Meanwhile welcomes focused changes that make the control plane simpler, safer, and more complete. Read [AGENTS.md](AGENTS.md) before changing code; it is the product and engineering contract, not background material.

The repository is pre-release. A completed module must satisfy its final ownership boundary, failure semantics, tests, and documentation; a new placeholder must never appear to work.

## Before opening a change

- Search existing issues and pull requests to avoid duplicate work.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) and do not open a public issue.
- For a new provider, agent adapter, deployment target, or persistence backend, describe the product property it adds and why an existing deep module cannot own it.
- Keep unrelated cleanup out of the change unless it is required to restore one controlling invariant.

Large architectural proposals should begin with a short issue containing:

1. the user-visible problem;
2. the current controlling code path;
3. the invariant that does not hold;
4. the smallest boundary that can own the fix;
5. migration, compatibility, security, and operational consequences;
6. the proof that will establish completion.

Do not start with a framework or abstraction proposal.

## Development setup

Prerequisites:

- Bun, using the exact toolchain declared by `package.json`;
- Git;
- Docker for container/Compose and Cloudflare image proof;
- Cloudflare credentials only for explicitly gated live tests.

```console
bun install
cp .env.example .env
bun run runtime:build
bun run doctor
bun test
```

The project uses Bun for runtime, package management, scripts, tests, process execution, and local SQLite. Do not introduce Node application shims, `dotenv`, `tsx`, root Vitest, or an alternative package manager.

Never place production credentials in `.env`, fixtures, snapshots, commits, CI logs, or issue text. The default local demo must run with deterministic fixtures and no cloud account.

## Architecture rules

The design in one sentence is:

> The control plane owns durable intent and policy; providers own disposable compute; the runtime-local runner owns ACP; artifact storage owns immutable bytes; deploy adapters promote those bytes.

Preserve these boundaries:

- routes authenticate, validate, call one service, and serialize;
- services and adapters never issue SQL; `Store` is the only SQL layer;
- `run-executor.ts` is the only owner of run-state transitions;
- provider selection disappears behind the registry and never branches in the executor;
- provider and deployment adapters never receive a database handle;
- prompts are ACP data and process launch always uses executable plus argv;
- artifact and deployment input is immutable and owner-scoped;
- cleanup is independent of run status and never deletes durable evidence;
- product logs, operational telemetry, and audit are separate data products;
- resolved secret values are never persisted;
- no `utils.ts`, `common.ts`, service base class, DI container, or interface/implementation mirror forest.

Read [Architecture](docs/architecture.md), [Provider contract](docs/provider-contract.md), and [Threat model](docs/threat-model.md) before touching the associated boundary.

## Work in dependency order

Prefer finishing the deepest dependency your change needs before adding its consumers:

1. domain, errors, validated config, telemetry facade, migrations, and store;
2. runner protocol, ACP session, deterministic fixture, and standalone runner;
3. provider/artifact/deployment contracts, registries, fakes, and local implementations;
4. agent session, executor, timeout, cancellation, reconciliation, cleanup, and API;
5. artifact capture and local deployment;
6. Cloudflare bridge and remote provider proof;
7. CLI, doctor, demo, containers, and release documentation.

Do not build a fake higher layer over an unimplemented lower contract to create visible progress.

## Quality gate

Before requesting review, run:

```console
bun run check
```

`check` runs Biome without mutation, strict TypeScript, license-notice verification, a clean runtime build, and the deterministic Bun test suite. Use `bun run typecheck` or `bun test` independently while iterating, but report the complete gate before review.

For runner changes:

```console
bun run runner:build
```

For Cloudflare bridge changes:

```console
bun run cloudflare:check
```

Credential-gated live tests are required before merging changes that claim Cloudflare lifecycle behavior. They must clean up resources in success and failure paths, while preserving enough evidence to diagnose cleanup failure.

Run the real-account proof only through its explicit gate:

```console
CLOUDFLARE_BRIDGE_URL=https://<bridge-worker> \
CLOUDFLARE_BRIDGE_TOKEN='<bridge token>' \
bun run test:live:cloudflare
```

`bun test` never infers permission to mutate Cloudflare from ambient credentials. The dedicated command fails clearly when its URL or token is missing; a skip is not a successful live proof.

When production dependencies change, run `bun run notices:generate` and review the resulting [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). The normal quality gate runs `notices:check` to reject stale dependency or license inventory.

If a new command is not implemented on a proposed branch, say so in the pull request. Do not replace a missing quality gate with a claim of success.

## Tests

Tests are organized by proof:

- `test/behavior/` proves product invariants such as isolation, idempotency, state, timeout, cancellation, cleanup, and deployment;
- `test/contracts/` proves provider, artifact, deployment, runner protocol, and telemetry replaceability;
- `test/integration/` proves real local composition and restart behavior;
- `test/live/` proves actual provider infrastructure behind an explicit credential gate;
- `test/fixtures/` contains deterministic ACP agents, clocks, and fakes.

Test rules:

- assert transitions, ordering, stable error codes, audit effects, and cleanup effects;
- inject clocks and deterministic adapters; do not sleep and hope;
- exercise races with controlled barriers rather than timing luck;
- run shared contracts against fake and real local implementations;
- keep live-provider tests separate and unmistakably gated;
- ensure every failure path destroys or durably records remote resources;
- search all durable output planes when testing secret leakage;
- never weaken an assertion to accommodate an unexplained race.

A mock proves replaceability. It does not prove a provider integration.

## Failure handling

Fix the owning cause. Do not add broad catches, silent retries, fallback defaults, feature flags, or special cases that turn an invariant failure into ambiguous state.

Expected external failures use explicit typed errors with stable codes, safe messages, retryability where meaningful, and bounded details. Unexpected invariant violations fail fast and produce correlated operational evidence without leaking private data.

Retries belong to a named durable policy with attempt count, next eligible time, and metrics. A loop hidden in an SDK wrapper is not a recovery design.

## Security requirements

Any changed output path must pass through the existing redaction boundary:

- run and deployment logs;
- public errors;
- provider diagnostics;
- structured operational logs and span attributes;
- audit metadata;
- artifact capture and previews.

Treat owner identity, provider handles, storage keys, paths, cursors, protocol frames, artifact metadata, and deployment selectors as untrusted at their boundary. Validate before authorization-sensitive lookup or side effects.

Changes to auth, secrets, process execution, filesystem traversal, artifacts, previews, provider bridge, deployment, or persistence require a threat-model review and adversarial tests.

## Database changes

- Add an ordered explicit migration; never mutate schema implicitly.
- Never edit a migration included in a release.
- Keep owner, state, order, and uniqueness invariants relational.
- Prefix owner-scoped indexes with `owner_id`.
- Use compare-and-swap predicates or status versions for state claims.
- Write transition audit evidence in the same transaction.
- Test fresh initialization and upgrade from supported schema fixtures.
- Document backup, rollback, and compatibility effects.

Resolved secret values and artifact bodies never belong in SQLite.

## Protocol and API changes

Meanwhile has independent compatibility surfaces:

- public HTTP/OpenAPI;
- runner protocol;
- Cloudflare bridge protocol;
- provider and deploy adapter contracts;
- database migrations;
- artifact representation;
- agent catalog schema.

For a change to any surface:

1. update its source schema and version deliberately;
2. add compatibility and rejection tests;
3. update examples and adjacent documentation in the same change;
4. record user-visible or operator-visible effects in `CHANGELOG.md`;
5. state upgrade and mixed-version behavior;
6. avoid an undocumented compatibility branch.

Zod/OpenAPI schemas are the API boundary source. Do not maintain a second handwritten response description that can drift.

## Adding a runtime provider

Follow [Provider contract](docs/provider-contract.md). In summary:

- keep SDK types inside the adapter/bridge;
- construct the adapter with provider-specific configuration;
- return versioned opaque secret-free handles;
- declare recovery, replay, and exposure capabilities truthfully;
- preserve stdout/stderr and monotonic event cursors;
- make stop and destroy idempotent and distinct;
- validate paths and prevent symlink escape;
- normalize errors without raw provider bodies;
- pass the shared suite and a real credential-gated lifecycle test.

Do not add a provider name check to core services.

## Documentation

Documentation is part of completion. Update the real controlling source and the nearest user/operator document in the same change.

- `AGENTS.md` owns product direction and architecture invariants.
- `README.md` owns quick start and product-facing usage.
- `docs/architecture.md` owns system explanation.
- `docs/provider-contract.md` owns provider authoring semantics.
- `docs/operations.md` owns operating and recovery procedures.
- `docs/threat-model.md` owns guarantees, assumptions, and residual risk.
- `CHANGELOG.md` owns release-visible compatibility and security changes.

Delete stale instructions instead of adding a competing description. Never describe an interface, fixture, mock, or planned command as an implemented feature.

## Pull requests

Keep each pull request independently understandable. Include:

- problem and user/operational consequence;
- controlling path and ownership decision;
- behavior before and after;
- security, compatibility, migration, and cleanup impact;
- exact verification commands and results;
- live-provider evidence when applicable;
- known limitations that remain.

Do not include credentials, private provider identifiers, raw customer prompts, or unredacted logs in screenshots or test evidence.

Review favors smaller ownership-complete changes over broad mechanical rewrites. The reviewer should be able to trace every new concept to a product property.

## AI-assisted contributions

AI assistance is permitted for design exploration, implementation, tests, review, and documentation. The contributor remains responsible for:

- understanding every changed line and dependency;
- verifying behavior rather than accepting generated claims;
- removing copied, incompatible, or unlicensed material;
- keeping secrets and private data out of prompts and outputs;
- disclosing material AI assistance in the pull request when it helps reviewers assess provenance or risk;
- meeting the same architecture, test, security, and documentation bar.

Conversation history is not design documentation. Durable decisions and evidence belong in the repository.

## License

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), and that you have the right to submit it under those terms.
