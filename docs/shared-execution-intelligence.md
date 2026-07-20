# Shared execution intelligence

Meanwhile should let one agent's durable output improve later work without turning the control plane into a hidden memory system.

The product outcome is concrete: agent A records a useful finding, the owner chooses to keep it, and agent B can reuse it in another run or session while seeing whether it came from the exact current workspace, an older commit, an unresolved revision, or a different workspace. Current workspace evidence always outranks historical prose.

## Product boundary

Shared intelligence is an explicit evidence flow:

```text
Run artifact → owner-curated Brief → accepted context snapshot → Run or Turn
       bytes stay authoritative          provenance + revalidation
```

It is not ambient chat history, automatic long-term memory, a vector database, or a second source of truth. Meanwhile owns identity, authorization, provenance, conflict semantics, and durable audit. The agent owns interpretation. The current workspace and newly produced evidence remain authoritative for the current task.

## Stable concepts

- **Artifact** owns immutable bytes produced by a run.
- **Brief** makes one bounded text or JSON artifact entry discoverable without copying it.
- **ExecutionContextArtifact** freezes the selected entry and its credential-free source-workspace basis into accepted work intent.
- **WorkspaceBasis** identifies a content-addressed bundle or a repository's requested revision and actual resolved commit.
- **WorkspaceRelationship** is a conservative comparison between historical evidence and current work: `exact`, `same_repository_changed`, `same_repository_unresolved`, `different_workspace`, or legacy `unknown`.

Relationship is provenance, not confidence. `exact` does not make an earlier conclusion true. `different_workspace` does not make transferable evidence useless. Every historical entry remains untrusted observation and must be checked against current files, tests, and runtime behavior.

## Delivery sequence

### 1. Evidence identity — implemented

Owners can promote captured output to a Brief and explicitly attach ordered Briefs to a later one-shot Run. Owner authorization, bounded media and size, immutable source identity, idempotency, runner-time byte revalidation, delimiter safety, restart persistence, and release proof share one contract.

### 2. Workspace relevance — implemented

Briefs expose their source-workspace basis. Run admission freezes that basis into context intent. After workspace preparation records the actual current commit, launch derives the workspace relationship and includes both bases and the classification in execution-context envelope v2. The derived relationship is not separately stored because its inputs are already durable.

### 3. Durable session reuse — implemented

A Turn, not an AgentSession, explicitly selects ordered Brief IDs. Turn admission owner-authorizes and freezes the same context snapshots in the turn idempotency hash. Dispatch revalidates and renders the same envelope before the versioned `turn.start` command. Attaching evidence silently to every future turn would create ambient hidden memory and is not allowed.

The session persists its prepared workspace basis, including the resolved repository commit, so Run and Turn use the same relevance semantics. Existing ACP continuity remains unchanged: a Brief-backed turn can teach the live context, but the durable evidence contract belongs to that turn.

### 4. Project authorization — prerequisite

The implemented Brief contract is owner-scoped because the current product has
no stable Actor or Project membership model. Before adding discovery, Briefs
must inherit the source Run's Project and every list/read/reuse path must enforce
active Project membership. The controlling sequence and two-person proof live
in [Project collaboration](project-collaboration.md).

### 5. Fact discovery and conflict handling — paused

Discovery should remain owner-directed and evidence-backed. A later contract may promote structured facts from declared artifact entries, but each fact must retain its source Brief and artifact identity. Search or ranking may propose evidence; it may never attach it automatically or become authoritative.

When multiple facts disagree, Meanwhile should expose the conflict and workspace relationships rather than merge prose into a synthetic truth. Supersession requires an explicit owner action and keeps the older source readable. Validation against current workspace evidence produces a new artifact or fact; it never mutates the old one.

## Acceptance bar

Each step must prove the whole ownership path through HTTP/OpenAPI, SDK, CLI or Board where relevant, SQLite restart persistence, owner isolation, idempotency conflict, runner/turn dispatch revalidation, prompt-injection containment, and semantic end-to-end output. Provider compatibility and credentialed live-agent proof remain separate evidence classes.

The current implementation stops at explicit owner-scoped Run and Turn reuse with workspace relevance. Project collaboration is the active milestone. Extraction, ranking, conflicts, and supersession remain paused and must not be described as shipped or next until Project authorization and the two-person product proof exist.
