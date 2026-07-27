import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  issueBrowserSession,
  issueConnectorDeviceSecret,
  LOCAL_BOOTSTRAP_OWNER_ID,
} from "../../src/auth"
import { Meanwhile } from "../../src/client"
import type { AuditRecord, BrowserSession } from "../../src/domain"
import type { ApplicationHarness } from "../application-harness"
import { bindTestGitHubRepository, createApplicationHarness } from "../application-harness"

let harness: ApplicationHarness

beforeEach(async () => {
  harness = await createApplicationHarness({ runConcurrency: 1 })
})

afterEach(async () => {
  await harness.close()
})

test("a browser adopts a device-local verifier atomically and the connector proves possession", async () => {
  const principal = (await json<{ principal: { id: string } }>(await harness.request("/me")))
    .principal
  const project = await createProject("adoption-primary")
  const browser = await createBrowserSession(principal.id)
  const issued = await issueConnectorDeviceSecret()
  const deviceId = crypto.randomUUID()
  const input = {
    deviceId,
    displayName: "Alice’s Mac",
    source: "codex",
    credentialPrefix: issued.prefix,
    credentialHash: issued.hash,
    projectId: project.id,
  }

  const adoptedResponse = await browserRequest(browser.secret, "/connector-devices/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  expect(adoptedResponse.status).toBe(201)
  const adopted = await json<{
    device: { id: string }
    grant: { id: string; projectId: string }
  }>(adoptedResponse)
  expect(adopted).toMatchObject({
    device: { id: deviceId },
    grant: { projectId: project.id },
  })
  expect(JSON.stringify(adopted)).not.toContain(issued.secret)
  expect(JSON.stringify(adopted)).not.toContain(issued.hash)
  expect(JSON.stringify(adopted)).not.toContain(issued.prefix)

  const client = new Meanwhile({
    baseUrl: "http://meanwhile.test",
    apiKey: harness.token,
    fetch: (request, init) => Promise.resolve(harness.application.app.request(request, init)),
  })
  const setup = await client.connectorDevices.setup(issued.secret)
  expect(setup).toEqual({
    device: expect.objectContaining({ id: deviceId, displayName: "Alice’s Mac", source: "codex" }),
    grants: [
      {
        id: adopted.grant.id,
        ownerId: LOCAL_BOOTSTRAP_OWNER_ID,
        projectId: project.id,
        connectorDeviceId: deviceId,
        source: "codex",
        authorizedByPrincipalId: principal.id,
        createdAt: expect.any(String),
        revokedAt: null,
      },
    ],
    repositories: [
      {
        projectId: project.id,
        repositoryId: "test-repository:adoption-primary",
        repositoryFullName: "acme/adoption-primary",
        repositoryUrl: "https://github.com/acme/adoption-primary",
      },
    ],
  })
  expect(Object.keys(setup).sort()).toEqual(["device", "grants", "repositories"])

  const audits = harness.application.store
    .listAudit(LOCAL_BOOTSTRAP_OWNER_ID)
    .filter((record) => record.resourceId === deviceId || record.resourceId === adopted.grant.id)
  expect(audits.map((record) => record.action).sort()).toEqual([
    "connector_device.adopt",
    "conversation_share_grant.create",
  ])

  const replay = await browserRequest(browser.secret, "/connector-devices/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  expect(replay.status).toBe(201)
  expect(await replay.json()).toMatchObject({
    device: { id: adopted.device.id },
    grant: { id: adopted.grant.id, projectId: project.id },
  })
  expect(
    harness.application.store
      .listAudit(LOCAL_BOOTSTRAP_OWNER_ID)
      .filter((record) => record.resourceId === deviceId || record.resourceId === adopted.grant.id),
  ).toHaveLength(2)

  expect(
    (
      await browserRequest(browser.secret, `/conversation-share-grants/${adopted.grant.id}`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(200)
  const afterRevoke = await json<{ grants: readonly unknown[] }>(
    await connectorRequest(issued.secret, "/connector/v1/setup"),
  )
  expect(afterRevoke.grants).toEqual([])
})

test("adoption fails closed across Projects and leaves no partial device on rejected authority", async () => {
  const principal = (await json<{ principal: { id: string } }>(await harness.request("/me")))
    .principal
  const first = await createProject("adoption-first")
  const second = await createProject("adoption-second")
  const browser = await createBrowserSession(principal.id)
  const issued = await issueConnectorDeviceSecret()
  const deviceId = crypto.randomUUID()
  const base = {
    deviceId,
    displayName: "Local Companion",
    source: "claude-code",
    credentialPrefix: issued.prefix,
    credentialHash: issued.hash,
  }
  expect(
    (
      await browserRequest(browser.secret, "/connector-devices/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, projectId: first.id }),
      })
    ).status,
  ).toBe(201)

  const conflict = await browserRequest(browser.secret, "/connector-devices/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, projectId: second.id }),
  })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: { code: "CONNECTOR_ADOPTION_CONFLICT" } })
  const metadataConflict = await browserRequest(browser.secret, "/connector-devices/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...base, displayName: "Renamed Companion", projectId: first.id }),
  })
  expect(metadataConflict.status).toBe(409)
  expect(
    harness.application.store.listConversationShareGrantsForPrincipal(
      LOCAL_BOOTSTRAP_OWNER_ID,
      principal.id,
    ),
  ).toHaveLength(1)

  const rejectedDeviceId = crypto.randomUUID()
  const rejectedIssued = await issueConnectorDeviceSecret()
  const rejected = await browserRequest(browser.secret, "/connector-devices/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...base,
      deviceId: rejectedDeviceId,
      credentialPrefix: rejectedIssued.prefix,
      credentialHash: rejectedIssued.hash,
      projectId: crypto.randomUUID(),
    }),
  })
  expect(rejected.status).toBe(404)
  expect(
    harness.application.store.getConnectorDevice(LOCAL_BOOTSTRAP_OWNER_ID, rejectedDeviceId),
  ).toBeNull()
})

async function createProject(slug: string): Promise<{ readonly id: string }> {
  const response = await harness.request("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: slug, slug }),
  })
  const project = (await json<{ project: { id: string } }>(response)).project
  bindTestGitHubRepository(harness, project.id, slug)
  return project
}

async function createBrowserSession(principalId: string): Promise<{ readonly secret: string }> {
  const issued = await issueBrowserSession()
  const now = new Date()
  const session: BrowserSession & { readonly prefix: string; readonly hash: string } = {
    id: crypto.randomUUID(),
    ownerId: LOCAL_BOOTSTRAP_OWNER_ID,
    principalId,
    prefix: issued.prefix,
    hash: issued.hash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  }
  harness.application.store.createBrowserSessionWithAudit({
    session,
    audit: audit("browser_session.create", "browser_session", session.id, now.toISOString()),
  })
  return { secret: issued.secret }
}

const browserRequest = (secret: string, path: string, init: RequestInit = {}) =>
  harness.application.app.request(path, {
    ...init,
    headers: {
      Authorization: `Session ${secret}`,
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  })

const connectorRequest = (secret: string, path: string, init: RequestInit = {}) =>
  harness.application.app.request(path, {
    ...init,
    headers: {
      Authorization: `Connector ${secret}`,
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  })

const audit = (
  action: string,
  resourceType: AuditRecord["resourceType"],
  resourceId: string,
  createdAt: string,
): AuditRecord => ({
  id: crypto.randomUUID(),
  ownerId: LOCAL_BOOTSTRAP_OWNER_ID,
  actorApiKeyId: null,
  action,
  resourceType,
  resourceId,
  requestId: "connector-adoption-test",
  traceId: null,
  metadata: {},
  createdAt,
})

async function json<Value>(response: Response): Promise<Value> {
  if (!response.ok) throw new Error(await response.text())
  return (await response.json()) as Value
}
