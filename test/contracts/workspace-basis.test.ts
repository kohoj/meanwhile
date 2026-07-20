import { expect, test } from "bun:test"
import type { WorkspaceBasis } from "../../src/domain"
import { workspaceRelationship } from "../../src/workspace-basis"

const repository = (resolvedRevision: string | null): WorkspaceBasis => ({
  type: "repository",
  url: "https://example.test/project.git",
  requestedRevision: "main",
  resolvedRevision,
})

test("workspace relationships distinguish exact, changed, unresolved, and different evidence", () => {
  const differentRepository: WorkspaceBasis = {
    type: "repository",
    url: "https://example.test/other.git",
    requestedRevision: "main",
    resolvedRevision: "a".repeat(40),
  }
  expect(workspaceRelationship(repository("a".repeat(40)), repository("A".repeat(40)))).toBe(
    "exact",
  )
  expect(workspaceRelationship(repository("a".repeat(40)), repository("b".repeat(40)))).toBe(
    "same_repository_changed",
  )
  expect(workspaceRelationship(repository(null), repository("a".repeat(40)))).toBe(
    "same_repository_unresolved",
  )
  expect(workspaceRelationship(repository("a".repeat(40)), differentRepository)).toBe(
    "different_workspace",
  )
  expect(
    workspaceRelationship(
      { type: "bundle", artifactId: "1".repeat(64) },
      { type: "bundle", artifactId: "1".repeat(64) },
    ),
  ).toBe("exact")
  expect(workspaceRelationship(null, repository("a".repeat(40)))).toBe("unknown")
})
