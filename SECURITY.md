# Security policy

Meanwhile executes code in local and remote runtimes and handles credentials, source, logs, artifacts, and deployments. Treat suspected vulnerabilities as sensitive until affected users can remediate.

## Supported versions

Meanwhile has no tagged release yet.

| Version | Security support |
| --- | --- |
| Unreleased development branch | Best effort; not a production support promise |
| Tagged releases | None yet |

This table will name supported release lines before the first stable release. Do not infer production support from an interface, passing mock, or development branch.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** form for this repository. Do not open a public issue, discussion, or pull request containing exploit details.

If private vulnerability reporting is unavailable, open a minimal public issue asking maintainers to enable a private reporting channel. Include no technical details, affected identifiers, credentials, logs, or artifacts in that issue.

A useful private report contains:

- affected revision or release;
- affected boundary: API/auth, runner/ACP, provider/bridge, persistence, artifacts, deployment/preview, secrets, or supply chain;
- prerequisites and minimal reproduction;
- observed and expected behavior;
- impact across owners, credentials, control plane, runtime, artifacts, or provider resources;
- whether the issue is actively exploited or publicly known;
- a safe test or patch, if available.

Replace real secrets and customer data with deterministic placeholders. Do not attach a database, private repository, access token, raw prompt, provider response, or unredacted log.

## What to expect

Maintainers aim to:

1. acknowledge a complete report within three business days;
2. establish impact and affected versions within seven business days;
3. agree on a disclosure plan with the reporter;
4. develop a fix at the owning boundary with regression tests;
5. rotate project-controlled credentials and clean up resources when relevant;
6. publish an advisory and release notes once users can remediate.

These are response goals, not a paid support SLA. Complex provider or supply-chain incidents may require coordination with upstream maintainers.

Please allow a reasonable private remediation window. Maintainers will credit reporters who request credit and follow coordinated disclosure. Meanwhile does not currently operate a bug-bounty program and cannot promise payment.

## In scope

Examples include:

- cross-owner access, existence disclosure, cancellation, deployment, artifact, log, or audit access;
- API-key hashing, verification, revocation, or authentication bypass;
- prompt-to-shell interpolation or arbitrary control-plane command execution;
- workspace traversal, symlink escape, arbitrary host-path access, or unsafe artifact capture;
- secret values reaching logs, telemetry, audit metadata, errors, artifacts, previews, or deployment logs;
- provider handles or bridge credentials crossing the public boundary;
- forged/replayed bridge requests or protocol confusion;
- runner frames that can forge another run, bypass sequence validation, or mutate durable state;
- terminal-state races that replace cancellation or timeout;
- cleanup that can destroy active or cross-owner compute;
- deployment from mutable or unauthorized source;
- preview origin confusion, path escape, active-content access to API authority, or cache isolation failure;
- malicious schema changes, dependency compromise, or release artifact provenance issues within this repository.

Underlying Cloudflare, Bun, ACP SDK, model provider, deployment platform, or operating-system vulnerabilities should also be reported to the affected upstream project through its private security process. Report them to Meanwhile when our integration makes the impact exploitable or requires downstream mitigation.

## Usually out of scope

- local-provider workload escape: local execution is explicitly not a sandbox;
- workspace-data exfiltration to a destination explicitly authorized by the accepted agent policy;
- credential disclosure by, or compromise of, an explicitly authorized upstream destination;
- denial of service requiring unlimited authorized workload where no quota is documented;
- social engineering, physical access, or compromise of a trusted host administrator;
- scanner-only reports without a reproducible impact;
- missing generic headers on endpoints where no concrete security property is affected;
- reports against forks, modified deployments, unsupported revisions, or leaked credentials not controlled by this project.

These exclusions do not make the risks unimportant. [Threat model](docs/threat-model.md) records the boundary and residual risk so deployment operators can choose appropriate isolation, credentials, quotas, and network controls.

## Handling suspected secret exposure

If you operate Meanwhile and suspect exposure:

1. revoke affected owner, bridge, provider, model, repository, and deployment credentials;
2. stop admission and affected work where doing so reduces harm;
3. quarantine affected artifacts and deployments without redistributing their contents;
4. preserve restricted audit, database, provider, and operational evidence;
5. inspect all three output planes through secure operator tooling;
6. destroy orphaned compute through the provider adapter;
7. restore service only after the owning output path is fixed and regression-tested.

Never copy suspected credential material into an issue, chat, ordinary log, fixture, or commit.

## Security design

The authoritative guarantees, assumptions, trust boundaries, non-goals, and verification plan are in [docs/threat-model.md](docs/threat-model.md). Operational response procedures are in [docs/operations.md](docs/operations.md).

Security-relevant fixes must update implementation, adversarial tests, threat model, operator guidance, and [CHANGELOG.md](CHANGELOG.md) together. A redaction-only patch is not sufficient when a secret crossed the wrong trust boundary.
