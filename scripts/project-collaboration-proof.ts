import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { issueApiKey } from "../src/auth"
import { Meanwhile, MeanwhileError } from "../src/client"
import type { DataRootPaths } from "../src/data-root"
import { backupDataRoot, restoreDataRoot, verifyDataBackup } from "../src/data-root"
import {
  createProjectCollaborationProofReceipt,
  writeProjectCollaborationProofReceipt,
} from "./project-collaboration-proof-receipt"

const repositoryRoot = resolve(new URL("../", import.meta.url).pathname)
const arguments_ = process.argv.slice(2)
const output = resolve(
  repositoryRoot,
  arguments_.find((argument) => argument.startsWith("--output="))?.slice("--output=".length) ??
    ".proof/project-collaboration.json",
)
const proofStartedAt = new Date().toISOString()
const temporaryRoot = await mkdtemp(join(tmpdir(), "meanwhile-project-proof-"))
const livePaths = dataRootPaths(join(temporaryRoot, "live"))
const restoredPaths = dataRootPaths(join(temporaryRoot, "restored"))
const backupPath = join(temporaryRoot, "backup")
const bootstrap = await issueApiKey()
const apiPort = await reservePort()
const previewPort = await reservePort()
const boardPort = await reservePort()
const apiOrigin = `http://127.0.0.1:${apiPort}`
const boardOrigin = `http://127.0.0.1:${boardPort}`
let controlPlane: ManagedProcess | null = null
let board: ManagedProcess | null = null

try {
  controlPlane = await startControlPlane(livePaths, bootstrap.key, apiPort, previewPort)
  board = await startBoard(apiOrigin, boardPort)

  const admin = client(apiOrigin, bootstrap.key)
  const setup = await admin.projects.me()
  const project = required(setup.projects[0], "Bootstrap Project is missing")
  const alicePrincipal = await admin.projects.createPrincipal({
    kind: "person",
    displayName: "Alice",
  })
  const bobPrincipal = await admin.projects.createPrincipal({ kind: "person", displayName: "Bob" })
  const carolPrincipal = await admin.projects.createPrincipal({
    kind: "person",
    displayName: "Carol",
  })
  await admin.projects.addMember(project.id, alicePrincipal.id, "member")
  await admin.projects.addMember(project.id, bobPrincipal.id, "member")

  const aliceCredential = await admin.apiKeys.create("Alice collaboration proof", {
    principalId: alicePrincipal.id,
  })
  const bobCredential = await admin.apiKeys.create("Bob collaboration proof", {
    principalId: bobPrincipal.id,
  })
  const carolCredential = await admin.apiKeys.create("Carol collaboration proof", {
    principalId: carolPrincipal.id,
  })
  let alice = client(apiOrigin, aliceCredential.secret)
  const bob = client(apiOrigin, bobCredential.secret)
  const carol = client(apiOrigin, carolCredential.secret)

  const proofToken = `project-collaboration-${crypto.randomUUID()}`
  const run = await alice.runs.wait(
    (
      await alice.runs.create(
        {
          projectId: project.id,
          workspace: {
            type: "files",
            files: [uploadedFile("README.md", "Shared Project release proof workspace")],
          },
          agentType: "demo",
          provider: "local",
          prompt: `Return ${proofToken} and publish it as the Project proof page.`,
          env: { FIXTURE_OUTPUT_PATH: "site/index.html" },
          artifactPaths: ["site"],
          timeoutMs: 20_000,
        },
        { idempotencyKey: "project-proof-alice-run" },
      )
    ).id,
    { timeoutMs: 30_000, pollIntervalMs: 50 },
  )
  assert(run.status === "succeeded", "Alice Run did not succeed")
  assert(run.delegatedBy.id === alicePrincipal.id, "Run attribution is not Alice")

  const session = await alice.sessions.create(
    {
      projectId: project.id,
      workspace: {
        type: "files",
        files: [uploadedFile("README.md", "Shared Project session proof workspace")],
      },
      agentType: "demo",
      provider: "local",
      idleTimeoutMs: 120_000,
    },
    { idempotencyKey: "project-proof-alice-session" },
  )
  await alice.sessions.waitForStatus(session.id, "idle", {
    timeoutMs: 20_000,
    pollIntervalMs: 50,
  })

  const [aliceWork, bobWork, bobRun, bobRunEvents, bobSessionEvents, artifacts] = await Promise.all(
    [
      alice.projects.work(project.id),
      bob.projects.work(project.id),
      bob.runs.get(run.id),
      bob.runs.events(run.id, { limit: 1_000 }),
      bob.sessions.events(session.id, { limit: 1_000 }),
      bob.artifacts.list(run.id),
    ],
  )
  assert(hasWork(aliceWork, "run", run.id), "Alice cannot see her Run in Project work")
  assert(hasWork(aliceWork, "session", session.id), "Alice cannot see her Session in Project work")
  assert(hasWork(bobWork, "run", run.id), "Bob cannot see Alice's Run in Project work")
  assert(hasWork(bobWork, "session", session.id), "Bob cannot see Alice's Session")
  assert(bobRun.delegatedBy.id === alicePrincipal.id, "Bob sees incorrect Run attribution")
  assert(
    bobRunEvents.items.some((event) => event.type === "agent.update"),
    "Bob cannot read Alice's Run conversation",
  )
  assert(bobSessionEvents.items.length > 0, "Bob cannot open Alice's Session history")
  const artifact = required(artifacts[0], "Alice Run did not capture an artifact")
  const artifactDownload = await bob.artifacts.download(artifact.id, { path: "index.html" })
  const artifactText = await new Response(artifactDownload.body).text()
  assert(artifactText.includes(proofToken), "Bob cannot read Alice's authorized task output")

  const aliceBoardSession = await boardLogin(boardOrigin, aliceCredential.secret)
  const bobBoardSession = await boardLogin(boardOrigin, bobCredential.secret)
  assert(
    aliceBoardSession.secret !== bobBoardSession.secret,
    "Board logins did not create independent browser sessions",
  )
  const [aliceBoard, bobBoard, bobConversation] = await Promise.all([
    boardJson(boardOrigin, `/board?projectId=${project.id}`, aliceBoardSession.cookie),
    boardJson(boardOrigin, `/board?projectId=${project.id}`, bobBoardSession.cookie),
    boardJson(boardOrigin, `/task/run/${run.id}/events`, bobBoardSession.cookie),
  ])
  assert(boardHasWork(aliceBoard, run.id), "Alice's Board does not show the Run")
  assert(boardHasWork(bobBoard, run.id), "Bob's Board does not show Alice's Run")
  assert(boardHasEvents(bobConversation), "Bob cannot open the Run conversation in Project Watch")
  await expectHttpStatus(
    fetch(`${boardOrigin}/task/run/${run.id}/events`, {
      method: "POST",
      headers: { Cookie: bobBoardSession.cookie },
    }),
    405,
    "Project Watch accepted a lifecycle mutation",
  )
  await expectHttpStatus(
    fetch(`${apiOrigin}/runs`, {
      method: "POST",
      headers: {
        Authorization: `Session ${bobBoardSession.secret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    403,
    "A read-only browser session accepted a mutation",
  )

  await expectNotFound(bob.runs.cancel(run.id), "Bob cancelled Alice's Run")
  await expectNotFound(
    bob.deployments.create(
      { runId: run.id, artifactPath: "site", deployTarget: "local-static" },
      { idempotencyKey: "bob-cannot-deploy-alice-run" },
    ),
    "Bob deployed Alice's Run",
  )
  await expectNotFound(
    bob.sessions.send(session.id, "Cross-member send must fail", {
      idempotencyKey: "bob-cannot-send-alice-session",
    }),
    "Bob sent a Turn to Alice's Session",
  )
  await expectNotFound(bob.sessions.interrupt(session.id), "Bob interrupted Alice's Session")
  await expectNotFound(bob.sessions.close(session.id), "Bob closed Alice's Session")

  assert((await carol.projects.list()).length === 0, "Carol inferred the Project from listing")
  await expectNotFound(carol.projects.get(project.id), "Carol read the Project")
  await expectNotFound(carol.runs.get(run.id), "Carol read Alice's Run")
  await expectNotFound(carol.runs.events(run.id), "Carol read Alice's Run events")
  await expectNotFound(carol.artifacts.get(artifact.id), "Carol read Alice's artifact")
  await expectNotFound(carol.sessions.get(session.id), "Carol read Alice's Session")

  const replacementAliceCredential = await alice.apiKeys.create("Alice rotated proof key")
  alice = client(apiOrigin, replacementAliceCredential.secret)
  await alice.apiKeys.revoke(aliceCredential.key.id)
  await expectUnauthenticated(
    client(apiOrigin, aliceCredential.secret).projects.me(),
    "Alice's revoked API key remained active",
  )
  const rotatedAlice = await alice.projects.me()
  assert(
    rotatedAlice.principal.id === alicePrincipal.id,
    "Credential rotation changed Alice's stable identity",
  )
  assert(
    (await alice.runs.get(run.id)).delegatedBy.id === alicePrincipal.id,
    "Credential rotation changed historical attribution",
  )
  assert(
    boardHasWork(
      await boardJson(boardOrigin, `/board?projectId=${project.id}`, aliceBoardSession.cookie),
      run.id,
    ),
    "Alice's Principal-bound browser session did not survive API-key rotation",
  )

  await admin.projects.removeMember(project.id, bobPrincipal.id)
  await expectNotFound(bob.projects.work(project.id), "Removed Bob retained SDK Project access")
  await expectNotFound(bob.runs.get(run.id), "Removed Bob retained SDK Run access")
  await expectHttpStatus(
    fetch(`${boardOrigin}/board?projectId=${project.id}`, {
      headers: { Cookie: bobBoardSession.cookie },
    }),
    404,
    "Removed Bob retained Project Watch access",
  )
  assert((await alice.projects.work(project.id)).length >= 2, "Alice lost Project access")

  await alice.sessions.close(session.id)
  await waitForSessionStatus(alice, session.id, "closed")
  await waitForRuntimeCleanup(admin, run.id, session.id)

  await board.stop()
  board = null
  await controlPlane.stop()
  controlPlane = null

  controlPlane = await startControlPlane(livePaths, bootstrap.key, apiPort, previewPort)
  board = await startBoard(apiOrigin, boardPort)
  alice = client(apiOrigin, replacementAliceCredential.secret)
  await assertPersistedAuthorization({
    alice,
    bob: client(apiOrigin, bobCredential.secret),
    projectId: project.id,
    runId: run.id,
    alicePrincipalId: alicePrincipal.id,
  })
  assert(
    boardHasWork(
      await boardJson(boardOrigin, `/board?projectId=${project.id}`, aliceBoardSession.cookie),
      run.id,
    ),
    "Project Watch did not recover after control-plane restart",
  )

  await board.stop()
  board = null
  await controlPlane.stop()
  controlPlane = null

  const backup = await backupDataRoot(livePaths, backupPath)
  const verifiedBackup = await verifyDataBackup(backupPath)
  assert(
    JSON.stringify(verifiedBackup) === JSON.stringify(backup),
    "Backup verification changed the accepted manifest",
  )
  await restoreDataRoot(backupPath, restoredPaths)

  controlPlane = await startControlPlane(restoredPaths, bootstrap.key, apiPort, previewPort)
  board = await startBoard(apiOrigin, boardPort)
  alice = client(apiOrigin, replacementAliceCredential.secret)
  await assertPersistedAuthorization({
    alice,
    bob: client(apiOrigin, bobCredential.secret),
    projectId: project.id,
    runId: run.id,
    alicePrincipalId: alicePrincipal.id,
  })
  assert(
    boardHasWork(
      await boardJson(boardOrigin, `/board?projectId=${project.id}`, aliceBoardSession.cookie),
      run.id,
    ),
    "Restored Project Watch does not show Alice's durable work",
  )
  await expectHttpStatus(
    fetch(`${boardOrigin}/board?projectId=${project.id}`, {
      headers: { Cookie: bobBoardSession.cookie },
    }),
    404,
    "Restored Project Watch revived Bob's removed membership",
  )

  const index = await fetch(`${boardOrigin}/`)
  const indexText = await index.text()
  assert(
    index.ok && indexText.includes("Meanwhile · Project Watch"),
    "Board assets are unavailable",
  )
  const designQa = (await Bun.file(join(repositoryRoot, "design-qa.md")).text()).trim()
  assert(designQa.endsWith("passed"), "Design QA is not accepted")
  const selectedReferenceDigest = await digestFile(
    join(repositoryRoot, "docs/assets/project-watch-selected.png"),
  )

  await board.stop()
  board = null
  await controlPlane.stop()
  controlPlane = null

  const privateValues = [
    bootstrap.key,
    aliceCredential.secret,
    replacementAliceCredential.secret,
    bobCredential.secret,
    carolCredential.secret,
    aliceBoardSession.secret,
    bobBoardSession.secret,
  ]
  await assertExactValuesAbsent(livePaths.dataDir, privateValues)
  await assertExactValuesAbsent(backupPath, privateValues)
  await assertExactValuesAbsent(restoredPaths.dataDir, privateValues)

  const receipt = createProjectCollaborationProofReceipt({
    startedAt: proofStartedAt,
    finishedAt: new Date().toISOString(),
    revision: await repositoryRevision(),
    topology: {
      controlPlaneOrigin: apiOrigin,
      boardOrigin,
      runtimeProvider: "local-deterministic",
      boardBoundary: "project-watch-bff",
    },
    identities: {
      alicePrincipalId: alicePrincipal.id,
      bobPrincipalId: bobPrincipal.id,
      carolPrincipalId: carolPrincipal.id,
      distinctPrincipals: true,
    },
    project: {
      id: project.id,
      aliceAndBobInitiallyActive: true,
      carolNeverMember: true,
    },
    work: {
      runId: run.id,
      sessionId: session.id,
      delegatedByAlice: true,
      visibleToAlice: true,
      visibleToBob: true,
      conversationVisibleToBob: true,
      artifactVisibleToBob: true,
    },
    authorization: {
      bobCancelAliceRun: "not_found",
      bobDeployAliceRun: "not_found",
      bobSendAliceSession: "not_found",
      bobInterruptAliceSession: "not_found",
      bobCloseAliceSession: "not_found",
      carolProjectList: "empty",
      carolProjectRead: "not_found",
      carolRunRead: "not_found",
      carolRunEvents: "not_found",
      carolArtifactRead: "not_found",
      carolSessionRead: "not_found",
      boardMutation: "method_not_allowed",
      browserSessionMutation: "forbidden",
    },
    browser: {
      independentAliceAndBobSessions: true,
      httpOnlyCookies: true,
      sameSiteStrictCookies: true,
      bothSeeAliceRun: true,
      bobOpenedTaskConversation: true,
    },
    credentialRotation: {
      oldAliceKeyRejected: true,
      replacementKeyAccepted: true,
      principalIdentityPreserved: true,
      historicalAttributionPreserved: true,
    },
    membershipRevocation: {
      bobRemoved: true,
      bobSdkReadDenied: true,
      bobBoardReadDenied: true,
      aliceUnaffected: true,
    },
    persistence: {
      restartVerified: true,
      backupDigest: await digestFile(join(backupPath, "manifest.json")),
      backupVerified: true,
      restoreVerified: true,
      attributionPreserved: true,
      currentMembershipEnforced: true,
      plaintextCredentialsAbsent: true,
    },
    presentation: {
      staticAssetsServed: true,
      selectedReferenceDigest,
      designQa: "passed",
    },
  })
  await writeProjectCollaborationProofReceipt(output, receipt)
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({
      status: "succeeded",
      proofClass: receipt.proofClass,
      revision: receipt.revision,
      receipt: output,
      receiptDigest: receipt.receiptDigest,
    })}\n`,
  )
} catch (error) {
  const failure = normalizeFailure(error)
  await Bun.write(Bun.stderr, `${JSON.stringify({ error: failure })}\n`)
  process.exitCode = 1
} finally {
  await board?.stop().catch(() => undefined)
  await controlPlane?.stop().catch(() => undefined)
  await rm(temporaryRoot, { recursive: true, force: true })
  await rm(`${livePaths.dataDir}.lock`, { recursive: true, force: true })
  await rm(`${restoredPaths.dataDir}.lock`, { recursive: true, force: true })
}

interface ManagedProcess {
  stop(): Promise<void>
}

interface BoardSession {
  readonly cookie: string
  readonly secret: string
}

function client(origin: string, apiKey: string): Meanwhile {
  return new Meanwhile({ baseUrl: origin, apiKey })
}

function uploadedFile(path: string, text: string) {
  return { path, contentBase64: new TextEncoder().encode(text).toBase64() }
}

function dataRootPaths(dataDir: string): DataRootPaths {
  return {
    dataDir,
    databasePath: join(dataDir, "meanwhile.sqlite"),
    artifactDir: join(dataDir, "artifacts"),
    runtimeDir: join(dataDir, "runtimes"),
    deploymentDir: join(dataDir, "deployments"),
  }
}

async function startControlPlane(
  paths: DataRootPaths,
  bootstrapKey: string,
  port: number,
  previewPort_: number,
): Promise<ManagedProcess> {
  const service = spawnService([process.execPath, "src/server.ts"], {
    MEANWHILE_HOST: "127.0.0.1",
    MEANWHILE_PORT: String(port),
    MEANWHILE_PREVIEW_HOST: "127.0.0.1",
    MEANWHILE_PREVIEW_PORT: String(previewPort_),
    MEANWHILE_DATA_DIR: paths.dataDir,
    MEANWHILE_API_KEY: bootstrapKey,
    MEANWHILE_RUNNER_PATH: join(repositoryRoot, "dist/meanwhile-runner"),
    MEANWHILE_AGENT_CATALOG: join(repositoryRoot, "config/agents.json"),
    MEANWHILE_DEFAULT_PROVIDER: "local",
    MEANWHILE_LOCAL_PROVIDER: "enabled",
    MEANWHILE_ALLOW_UNSAFE_LOCAL_PROVIDER: "false",
    MEANWHILE_LOG_LEVEL: "error",
    MEANWHILE_OTEL_ENABLED: "false",
  })
  try {
    await waitForHttp(`http://127.0.0.1:${port}/readyz`, 20_000)
    return service
  } catch (error) {
    await service.stop()
    throw error
  }
}

async function startBoard(controlPlaneOrigin: string, port: number): Promise<ManagedProcess> {
  const service = spawnService([process.execPath, "board/src/main.ts"], {
    MEANWHILE_URL: controlPlaneOrigin,
    MEANWHILE_BOARD_HOST: "127.0.0.1",
    MEANWHILE_BOARD_PORT: String(port),
  })
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 10_000)
    return service
  } catch (error) {
    await service.stop()
    throw error
  }
}

function spawnService(argv: readonly string[], environment: Record<string, string>) {
  const process_ = Bun.spawn([...argv], {
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  let stopped = false
  return {
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      if (process_.exitCode === null) process_.kill("SIGTERM")
      const exitCode = await Promise.race([
        process_.exited,
        Bun.sleep(5_000).then(() => {
          if (process_.exitCode === null) process_.kill("SIGKILL")
          return process_.exited
        }),
      ])
      const stderr = await new Response(process_.stderr).text()
      if (exitCode !== 0 && exitCode !== 143 && stderr.trim().length > 0) {
        throw new Error(`Service exited unexpectedly: ${stderr.trim()}`)
      }
    },
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const response = await fetch(url).catch(() => null)
    if (response?.ok) {
      await response.body?.cancel().catch(() => undefined)
      return
    }
    await response?.body?.cancel().catch(() => undefined)
    await Bun.sleep(50)
  }
  throw new Error(`Service did not become ready: ${url}`)
}

async function boardLogin(origin: string, apiKey: string): Promise<BoardSession> {
  const response = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  })
  const setCookie = response.headers.get("set-cookie") ?? ""
  assert(response.status === 201, `Project Watch login failed with ${response.status}`)
  assert(setCookie.includes("HttpOnly"), "Project Watch cookie is not HttpOnly")
  assert(setCookie.includes("SameSite=Strict"), "Project Watch cookie is not SameSite=Strict")
  const cookie = setCookie.split(";", 1)[0] ?? ""
  const encodedSecret = cookie.split("=", 2)[1] ?? ""
  const secret = decodeURIComponent(encodedSecret)
  assert(/^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(secret), "Invalid browser session")
  return { cookie, secret }
}

async function boardJson(origin: string, path: string, cookie: string): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, { headers: { Cookie: cookie } })
  assert(response.ok, `Project Watch request failed with ${response.status}: ${path}`)
  return response.json()
}

function boardHasWork(value: unknown, workId: string): boolean {
  if (!isRecord(value) || !Array.isArray(value["rows"])) return false
  return value["rows"].some((row) => isRecord(row) && row["id"] === workId)
}

function boardHasEvents(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value["events"]) && value["events"].length > 0
}

function hasWork(
  items: readonly { readonly kind: "run" | "session"; readonly id: string }[],
  kind: "run" | "session",
  id: string,
): boolean {
  return items.some((item) => item.kind === kind && item.id === id)
}

async function expectNotFound(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    if (error instanceof MeanwhileError && error.status === 404) return
    throw error
  }
  throw new Error(message)
}

async function expectUnauthenticated(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    if (error instanceof MeanwhileError && error.status === 401) return
    throw error
  }
  throw new Error(message)
}

async function expectHttpStatus(
  responsePromise: Promise<Response>,
  expectedStatus: number,
  message: string,
): Promise<void> {
  const response = await responsePromise
  await response.body?.cancel().catch(() => undefined)
  if (response.status !== expectedStatus) {
    throw new Error(`${message}: expected ${expectedStatus}, received ${response.status}`)
  }
}

async function waitForSessionStatus(
  meanwhile: Meanwhile,
  sessionId: string,
  status: "closed",
): Promise<void> {
  const deadline = performance.now() + 20_000
  while (performance.now() < deadline) {
    if ((await meanwhile.sessions.get(sessionId)).status === status) return
    await Bun.sleep(50)
  }
  throw new Error(`Session did not reach ${status}`)
}

async function waitForRuntimeCleanup(
  admin: Meanwhile,
  runId: string,
  sessionId: string,
): Promise<void> {
  const deadline = performance.now() + 20_000
  while (performance.now() < deadline) {
    const page = await admin.audit.list({ action: "runtime.destroy", limit: 100 })
    const runCleanup = page.items.some(
      (record) => record.metadata["runId"] === runId && record.metadata["outcome"] === "succeeded",
    )
    const sessionCleanup = page.items.some(
      (record) =>
        record.metadata["sessionId"] === sessionId && record.metadata["succeeded"] === true,
    )
    if (runCleanup && sessionCleanup) return
    await Bun.sleep(50)
  }
  throw new Error("Run and Session cleanup did not complete")
}

async function assertPersistedAuthorization(input: {
  readonly alice: Meanwhile
  readonly bob: Meanwhile
  readonly projectId: string
  readonly runId: string
  readonly alicePrincipalId: string
}): Promise<void> {
  const aliceMe = await input.alice.projects.me()
  assert(aliceMe.principal.id === input.alicePrincipalId, "Alice identity did not persist")
  const restoredRun = await input.alice.runs.get(input.runId)
  assert(restoredRun.projectId === input.projectId, "Run Project binding did not persist")
  assert(
    restoredRun.delegatedBy.id === input.alicePrincipalId,
    "Run delegator attribution did not persist",
  )
  await expectNotFound(
    input.bob.projects.work(input.projectId),
    "Bob's removed membership became active after persistence transition",
  )
  await expectNotFound(
    input.bob.runs.get(input.runId),
    "Bob regained Run access after persistence transition",
  )
}

async function assertExactValuesAbsent(root: string, values: readonly string[]): Promise<void> {
  const needles = values.map((value) => new TextEncoder().encode(value))
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) return
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) throw new Error("Proof data contains an unsupported filesystem entry")
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
      if (needles.some((needle) => containsBytes(bytes, needle))) {
        throw new Error("A plaintext credential reached durable collaboration proof data")
      }
    }
  }
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false
  const finalStart = haystack.byteLength - needle.byteLength
  for (let start = 0; start <= finalStart; start += 1) {
    let matches = true
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

async function digestFile(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`
}

async function repositoryRevision(): Promise<{ readonly commit: string; readonly dirty: boolean }> {
  const commit = await commandOutput(["git", "rev-parse", "HEAD"])
  const status = await commandOutput(["git", "status", "--porcelain"])
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Repository revision is invalid")
  return { commit, dirty: status.length > 0 }
}

async function commandOutput(argv: readonly [string, ...string[]]): Promise<string> {
  const process_ = Bun.spawn([...argv], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "ignore",
  })
  const output_ = await new Response(process_.stdout).text()
  if ((await process_.exited) !== 0) throw new Error("Repository revision could not be read")
  return output_.trim()
}

async function reservePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Ephemeral port is unavailable")
  return port
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeFailure(error: unknown): {
  readonly code: string
  readonly message: string
} {
  if (error instanceof MeanwhileError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: error.name, message: error.message }
  return { code: "INTERNAL", message: "Unknown collaboration proof failure" }
}
