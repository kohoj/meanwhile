import { describe, expect, test } from "bun:test"
import { isSafeRepositoryRevision } from "../../src/domain"
import { runtimeHandle } from "../../src/providers/runtime-provider"
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
})
