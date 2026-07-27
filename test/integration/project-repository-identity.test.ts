import { afterEach, beforeEach, expect, test } from "bun:test"
import { LOCAL_BOOTSTRAP_OWNER_ID } from "../../src/auth"
import type { ProjectRepositoryBinding } from "../../src/domain"
import type { ApplicationHarness } from "../application-harness"
import { bindTestGitHubRepository, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness

beforeEach(async () => {
  harness = await createApplicationHarness({ runConcurrency: 1, sessionConcurrency: 1 })
})

afterEach(async () => {
  await harness.close()
})

test("one GitHub repository has one immutable Project identity", async () => {
  const first = await createProject("northstar-one")
  const second = await createProject("northstar-two")
  bindTestGitHubRepository(harness, first, "northstar")
  const binding = harness.application.store.getActiveProjectRepositoryBinding(
    LOCAL_BOOTSTRAP_OWNER_ID,
    first,
  ) as ProjectRepositoryBinding
  expect(() =>
    harness.application.store.bindProjectRepositoryWithAudit({
      binding: { ...binding, id: crypto.randomUUID(), projectId: second },
      audit: audit("duplicate-repository"),
    }),
  ).toThrow("already belongs to another Project")

  const other = await createProject("other-repository")
  bindTestGitHubRepository(harness, other, "other")
  const otherBinding = harness.application.store.getActiveProjectRepositoryBinding(
    LOCAL_BOOTSTRAP_OWNER_ID,
    other,
  ) as ProjectRepositoryBinding
  expect(() =>
    harness.application.store.bindProjectRepositoryWithAudit({
      binding: { ...otherBinding, id: crypto.randomUUID(), projectId: first },
      audit: audit("rebind-project"),
    }),
  ).toThrow("already bound to a different GitHub repository")
})

test("Run and Session admission reject a workspace from another GitHub Project", async () => {
  const projectId = await createProject("northstar-work")
  const repository = bindTestGitHubRepository(harness, projectId, "northstar")
  const wrongWorkspace = {
    type: "repository",
    url: "https://github.com/acme/other",
  }
  const run = await harness.request("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      workspace: wrongWorkspace,
      agentType: "demo",
      prompt: "Do not run in another repository",
    }),
  })
  expect(run.status).toBe(409)
  expect(await run.json()).toMatchObject({ error: { code: "PROJECT_REPOSITORY_MISMATCH" } })

  const session = await harness.request("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      workspace: wrongWorkspace,
      agentType: "demo",
    }),
  })
  expect(session.status).toBe(409)
  expect(await session.json()).toMatchObject({ error: { code: "PROJECT_REPOSITORY_MISMATCH" } })

  const accepted = await harness.request("/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      workspace: {
        type: "repository",
        url: `${repository.repositoryFullName}.git`.replace(/^/, "https://github.com/"),
      },
      agentType: "demo",
      prompt: "Stay in the Project repository",
    }),
  })
  expect(accepted.status).toBe(201)
})

async function createProject(slug: string): Promise<string> {
  const response = await harness.request("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: slug, slug }),
  })
  if (!response.ok) throw new Error(await response.text())
  return ((await response.json()) as { project: { id: string } }).project.id
}

function audit(action: string) {
  return {
    id: crypto.randomUUID(),
    ownerId: LOCAL_BOOTSTRAP_OWNER_ID,
    actorApiKeyId: null,
    action,
    resourceType: "project_repository_binding" as const,
    resourceId: crypto.randomUUID(),
    requestId: "project-repository-identity-test",
    traceId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
  }
}
