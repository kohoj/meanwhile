import { resolve } from "node:path"
import { Meanwhile, MeanwhileError } from "../src/client"
import {
  createDeployedCollaborationProofReceipt,
  writeDeployedCollaborationProofReceipt,
} from "./deployed-collaboration-proof-receipt"

const repositoryRoot = resolve(new URL("../", import.meta.url).pathname)
const arguments_ = process.argv.slice(2)
const controlPlaneOrigin = requiredUrlOption("control-plane-origin")
const boardOrigin = requiredUrlOption("board-origin")
const projectId = requiredOption("project")
const output = resolve(
  repositoryRoot,
  option("output") ?? ".proof/deployed-project-collaboration.json",
)
const requireClean = arguments_.includes("--require-clean")
const firstApiKey = requiredApiKey("MEANWHILE_FIRST_API_KEY")
const secondApiKey = requiredApiKey("MEANWHILE_SECOND_API_KEY")
const proofStartedAt = new Date().toISOString()
const proofIdentity = crypto.randomUUID()
let firstBoardSession: BoardSession | null = null
let secondBoardSession: BoardSession | null = null

try {
  assertHttps(controlPlaneOrigin, "Control-plane")
  assertHttps(boardOrigin, "Project Watch")
  assert(firstApiKey !== secondApiKey, "Deployed proof requires independent API keys")

  const revision = await repositoryRevision()
  if (requireClean && revision.dirty) {
    throw new Error("Deployed collaboration proof requires a clean worktree")
  }

  const first = new Meanwhile({ baseUrl: controlPlaneOrigin, apiKey: firstApiKey })
  const second = new Meanwhile({ baseUrl: controlPlaneOrigin, apiKey: secondApiKey })
  const [firstIdentity, secondIdentity] = await Promise.all([
    first.projects.me(),
    second.projects.me(),
  ])
  assert(
    firstIdentity.principal.id !== secondIdentity.principal.id,
    "Deployed proof requires two distinct Principals",
  )
  assert(
    firstIdentity.projects.some((project) => project.id === projectId),
    "First Principal is not an active Project member",
  )
  assert(
    secondIdentity.projects.some((project) => project.id === projectId),
    "Second Principal is not an active Project member",
  )

  const [firstRun, secondRun] = await Promise.all([
    createProofRun({
      client: first,
      projectId,
      idempotencyKey: `deployed-collaboration:${proofIdentity}:first`,
      prompt:
        "Verify the shared Project from the first member's perspective and summarize the collaboration boundary in one sentence.",
    }),
    createProofRun({
      client: second,
      projectId,
      idempotencyKey: `deployed-collaboration:${proofIdentity}:second`,
      prompt:
        "Verify the shared Project from the second member's perspective and summarize the collaboration boundary in one sentence.",
    }),
  ])
  assert(firstRun.delegatedBy.id === firstIdentity.principal.id, "First Run attribution drifted")
  assert(secondRun.delegatedBy.id === secondIdentity.principal.id, "Second Run attribution drifted")

  const [firstWork, secondWork, firstReadsSecond, secondReadsFirst] = await Promise.all([
    first.projects.work(projectId),
    second.projects.work(projectId),
    first.runs.events(secondRun.id, { limit: 1_000 }),
    second.runs.events(firstRun.id, { limit: 1_000 }),
  ])
  assert(hasWork(firstWork, firstRun.id), "First member cannot see their own Run")
  assert(hasWork(firstWork, secondRun.id), "First member cannot see the second member's Run")
  assert(hasWork(secondWork, firstRun.id), "Second member cannot see the first member's Run")
  assert(hasWork(secondWork, secondRun.id), "Second member cannot see their own Run")
  assert(firstReadsSecond.items.length > 0, "First member cannot open the second conversation")
  assert(secondReadsFirst.items.length > 0, "Second member cannot open the first conversation")

  await Promise.all([
    expectNotFound(first.runs.cancel(secondRun.id), "First member cancelled the second Run"),
    expectNotFound(second.runs.cancel(firstRun.id), "Second member cancelled the first Run"),
  ])

  firstBoardSession = await boardLogin(boardOrigin, firstApiKey)
  secondBoardSession = await boardLogin(boardOrigin, secondApiKey)
  assert(
    firstBoardSession.secret !== secondBoardSession.secret,
    "Project Watch reused one browser session for two Principals",
  )
  const [firstBoard, secondBoard, firstBoardConversation, secondBoardConversation] =
    await Promise.all([
      boardJson(boardOrigin, `/board?projectId=${projectId}`, firstBoardSession.cookie),
      boardJson(boardOrigin, `/board?projectId=${projectId}`, secondBoardSession.cookie),
      boardJson(boardOrigin, `/task/run/${secondRun.id}/events`, firstBoardSession.cookie),
      boardJson(boardOrigin, `/task/run/${firstRun.id}/events`, secondBoardSession.cookie),
    ])
  assert(boardHasWork(firstBoard, firstRun.id), "First Board is missing the first Run")
  assert(boardHasWork(firstBoard, secondRun.id), "First Board is missing the second Run")
  assert(boardHasWork(secondBoard, firstRun.id), "Second Board is missing the first Run")
  assert(boardHasWork(secondBoard, secondRun.id), "Second Board is missing the second Run")
  assert(boardHasEvents(firstBoardConversation), "First Board cannot open the second conversation")
  assert(boardHasEvents(secondBoardConversation), "Second Board cannot open the first conversation")

  await expectHttpStatus(
    fetch(`${boardOrigin}/task/run/${firstRun.id}/events`, {
      method: "POST",
      headers: { Cookie: secondBoardSession.cookie },
    }),
    405,
    "Project Watch accepted a mutation",
  )
  await expectHttpStatus(
    fetch(new URL("runs", controlPlaneOrigin), {
      method: "POST",
      headers: {
        Authorization: `Session ${secondBoardSession.secret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    403,
    "A read-only browser session accepted a control-plane mutation",
  )

  const receipt = createDeployedCollaborationProofReceipt({
    startedAt: proofStartedAt,
    finishedAt: new Date().toISOString(),
    revision,
    topology: {
      controlPlaneOrigin,
      boardOrigin,
      controlPlaneTransport: "https",
      boardTransport: "https",
      runtimeProvider: "local",
      agentType: "demo",
      boardBoundary: "project-watch-bff",
    },
    identities: {
      firstPrincipalId: firstIdentity.principal.id,
      secondPrincipalId: secondIdentity.principal.id,
      distinctPrincipals: true,
    },
    project: { id: projectId, bothMembersActive: true },
    work: {
      firstRunId: firstRun.id,
      secondRunId: secondRun.id,
      firstRunAttributed: true,
      secondRunAttributed: true,
      firstSeesSecondRun: true,
      secondSeesFirstRun: true,
      firstOpenedSecondConversation: true,
      secondOpenedFirstConversation: true,
    },
    authorization: {
      firstCannotCancelSecondRun: "not_found",
      secondCannotCancelFirstRun: "not_found",
      boardMutation: "method_not_allowed",
      browserSessionMutation: "forbidden",
    },
    browser: {
      independentSessions: true,
      httpOnlyCookies: true,
      sameSiteStrictCookies: true,
      secureCookies: true,
      bothBoardsSeeBothRuns: true,
    },
    security: { plaintextCredentialsAbsent: true },
    claimBoundary: { externalHumanAcceptance: "not_claimed" },
  })
  assertReceiptExcludesSecrets(receipt, [
    firstApiKey,
    secondApiKey,
    firstBoardSession.secret,
    secondBoardSession.secret,
  ])
  await writeDeployedCollaborationProofReceipt(output, receipt)
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({
      status: "succeeded",
      proofClass: receipt.proofClass,
      revision: receipt.revision,
      receipt: output,
      receiptDigest: receipt.receiptDigest,
      externalHumanAcceptance: receipt.claimBoundary.externalHumanAcceptance,
    })}\n`,
  )
} catch (error) {
  await Bun.write(
    Bun.stderr,
    `${JSON.stringify({
      error: {
        code: "DEPLOYED_COLLABORATION_PROOF_FAILED",
        message: error instanceof Error ? error.message : "Deployed collaboration proof failed",
      },
    })}\n`,
  )
  process.exitCode = 1
} finally {
  await Promise.all([
    logoutBoard(boardOrigin, firstBoardSession?.cookie),
    logoutBoard(boardOrigin, secondBoardSession?.cookie),
  ])
}

interface BoardSession {
  readonly cookie: string
  readonly secret: string
}

async function createProofRun(input: {
  readonly client: Meanwhile
  readonly projectId: string
  readonly idempotencyKey: string
  readonly prompt: string
}) {
  const created = await input.client.runs.create(
    {
      projectId: input.projectId,
      workspace: {
        type: "files",
        files: [uploadedFile("README.md", "Meanwhile deployed collaboration proof workspace")],
      },
      agentType: "demo",
      provider: "local",
      prompt: input.prompt,
      env: {},
      artifactPaths: [],
      timeoutMs: 20_000,
    },
    { idempotencyKey: input.idempotencyKey },
  )
  const completed = await input.client.runs.wait(created.id, {
    timeoutMs: 30_000,
    pollIntervalMs: 100,
  })
  assert(completed.status === "succeeded", `Proof Run ${completed.id} did not succeed`)
  return completed
}

function uploadedFile(path: string, text: string) {
  return { path, contentBase64: new TextEncoder().encode(text).toBase64() }
}

function hasWork(items: readonly { readonly id: string }[], id: string): boolean {
  return items.some((item) => item.id === id)
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
  assert(setCookie.includes("Secure"), "Project Watch cookie is not Secure")
  const cookie = setCookie.split(";", 1)[0] ?? ""
  const secret = decodeURIComponent(cookie.split("=", 2)[1] ?? "")
  assert(/^mws_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(secret), "Invalid browser session")
  return { cookie, secret }
}

async function boardJson(origin: string, path: string, cookie: string): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, { headers: { Cookie: cookie } })
  assert(response.ok, `Project Watch request failed with ${response.status}: ${path}`)
  return response.json()
}

async function logoutBoard(origin: string, cookie: string | undefined): Promise<void> {
  if (cookie === undefined) return
  const response = await fetch(`${origin}/logout`, {
    method: "POST",
    headers: { Cookie: cookie },
  }).catch(() => null)
  await response?.body?.cancel().catch(() => undefined)
}

function boardHasWork(value: unknown, workId: string): boolean {
  if (!isRecord(value) || !Array.isArray(value["rows"])) return false
  return value["rows"].some((row) => isRecord(row) && row["id"] === workId)
}

function boardHasEvents(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value["events"]) && value["events"].length > 0
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

function assertReceiptExcludesSecrets(receipt: unknown, privateValues: readonly string[]): void {
  const serialized = JSON.stringify(receipt)
  if (privateValues.some((value) => value.length > 0 && serialized.includes(value))) {
    throw new Error("Deployed collaboration proof receipt contains a credential")
  }
}

function requiredApiKey(name: "MEANWHILE_FIRST_API_KEY" | "MEANWHILE_SECOND_API_KEY"): string {
  const value = Bun.env[name]?.trim() ?? ""
  if (!/^mwk_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError(`${name} must contain a valid Meanwhile API key`)
  }
  return value
}

function requiredUrlOption(name: string): string {
  const value = requiredOption(name)
  const url = new URL(value)
  return url.toString()
}

function requiredOption(name: string): string {
  const value = option(name)
  if (value === undefined || value.length === 0) throw new TypeError(`--${name} is required`)
  return value
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`
  return arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function assertHttps(origin: string, label: string): void {
  if (new URL(origin).protocol !== "https:") throw new Error(`${label} ingress must use HTTPS`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
