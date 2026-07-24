import { describe, expect, test } from "bun:test"
import { isSafeRepositoryRevision } from "../../src/domain"
import {
  type ProcessSpec,
  type RuntimeHandle,
  runtimeHandle,
} from "../../src/providers/runtime-provider"
import { WorkspacePreparer } from "../../src/services/workspace-preparer"
import { MockRuntimeProvider } from "../fixtures/mock-provider"

describe("repository revision boundary", () => {
  test.each([
    "HEAD",
    "main",
    "feature/agent-runtime",
    "release/v1.2.3",
    "refs/heads/main",
    "refs/tags/v1.2.3",
    "0123456",
    "0123456789abcdef0123456789abcdef01234567",
  ])("accepts the literal revision %s", (revision) => {
    expect(isSafeRepositoryRevision(revision)).toBe(true)
  })

  test.each([
    "",
    "--upload-pack=/tmp/owned",
    "-c",
    "deadbe",
    "../main",
    "feature/../main",
    "feature//main",
    ".hidden/main",
    "main.lock",
    "main.",
    "main@{1}",
    "main..next",
    "main...next",
    "main^",
    "main~2",
    "main:path",
    "refs/heads/main\n--upload-pack=owned",
    "refs\\heads\\main",
  ])("rejects the unsafe or ambiguous revision %s", (revision) => {
    expect(isSafeRepositoryRevision(revision)).toBe(false)
  })

  test("rejects option injection before invoking the provider", async () => {
    const provider = new MockRuntimeProvider()
    const preparer = new WorkspacePreparer({
      read: async () => {
        throw new Error("bundle reader must not be used")
      },
    })

    expect(
      preparer.prepare({
        ownerId: "owner-a",
        runId: "run-a",
        source: {
          type: "repository",
          url: "https://example.test/repository.git",
          revision: "--upload-pack=/tmp/owned",
        },
        provider,
        runtime: runtimeHandle(provider.name, "runtime-a"),
        timeoutMs: 10_000,
        terminationGraceMs: 1_000,
        signal: new AbortController().signal,
        emit: async () => {},
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })

    expect(provider.operations).toEqual([])
  })

  test("keeps a preformatted GitHub credential out of argv and the repository URL", async () => {
    const provider = new CredentialCapturingProvider()
    const runtime = await provider.create({ runtimeId: "runtime-private-repository" })
    await provider.start(runtime)
    const preparer = new WorkspacePreparer({ read: async () => [] })
    const credential = `Basic ${new TextEncoder()
      .encode("x-access-token:private-token")
      .toBase64()}`

    await preparer.prepare({
      ownerId: "owner-a",
      runId: "run-private",
      source: {
        type: "repository",
        url: "https://github.com/acme/private-repository",
        revision: "main",
      },
      provider,
      runtime,
      repositoryCredential: credential,
      timeoutMs: 10_000,
      terminationGraceMs: 1_000,
      signal: new AbortController().signal,
      emit: async () => {},
    })

    const fetch = provider.specs.find((spec) => spec.processId.endsWith("-git-fetch"))
    expect(fetch?.env?.["GIT_CONFIG_VALUE_0"]).toBe(`Authorization: ${credential}`)
    expect(fetch?.argv).toEqual(["git", "fetch", "--quiet", "--depth=1", "--", "origin", "main"])
    expect(JSON.stringify(provider.specs)).not.toContain("private-token")
    expect(JSON.stringify(provider.specs)).not.toContain("x-access-token")
  })
})

class CredentialCapturingProvider extends MockRuntimeProvider {
  readonly specs: ProcessSpec[] = []

  override async spawn(runtime: RuntimeHandle, spec: ProcessSpec) {
    this.specs.push(spec)
    const process = await super.spawn(runtime, spec)
    if (spec.processId.endsWith("-git-revision")) {
      this.emit(process, "stdout", `${"a".repeat(40)}\n`)
    }
    this.complete(process, 0)
    return process
  }
}
