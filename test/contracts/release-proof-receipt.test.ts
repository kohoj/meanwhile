import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createReleaseProofReceipt,
  RELEASE_PROOF_RECEIPT_VERSION,
  releaseProofClass,
  verifyReleaseProofReceipt,
  writeReleaseProofReceipt,
} from "../../scripts/release-proof-receipt"

const temporaryDirectories: string[] = []
const sha256 = "a".repeat(64)
const otherSha256 = "b".repeat(64)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("release proof receipt", () => {
  test("classifies local, remote compatibility, and live-agent evidence without model claims", () => {
    expect(releaseProofClass("local", "demo")).toBe("local-control-plane")
    expect(releaseProofClass("cloudflare", "demo")).toBe("remote-provider-compatibility")
    expect(releaseProofClass("cloudflare", "codex")).toBe("remote-live-agent")
    expect(() => releaseProofClass("local", "codex")).toThrow(
      "Local release proof supports only the demo agent",
    )

    const live = createReleaseProofReceipt(proofInput("cloudflare", "codex"))
    expect(live.agent.executionEvidence).toBe("credentialed-live-agent")
    expect(live.agent.modelIdentityEvidence).toBe("not-attested")
    expect(live.credentialBoundary).toMatchObject({
      mode: "brokered",
      runLeaseRevoked: true,
      sessionLeaseRevoked: true,
      sourceValuesAbsent: true,
    })
    expect(live).not.toHaveProperty("agent.realModel")
    expect(() =>
      createReleaseProofReceipt({
        ...proofInput("cloudflare", "codex"),
        credentialBoundary: {
          mode: "not-required",
          runLeaseId: null,
          sessionLeaseId: null,
          runLeaseRevoked: null,
          sessionLeaseRevoked: null,
          sourceValuesAbsent: true,
        },
      }),
    ).toThrow("Credential evidence does not match the selected agent")
  })

  test("detects any mutation of accepted evidence", () => {
    const receipt = createReleaseProofReceipt(proofInput("local", "demo"))
    expect(verifyReleaseProofReceipt(receipt)).toEqual(receipt)

    const mutated = structuredClone(receipt)
    mutated.artifact.digest = otherSha256
    expect(() => verifyReleaseProofReceipt(mutated)).toThrow(
      "Release proof receipt digest does not match its evidence",
    )
  })

  test("emits version 2 Brief evidence while retaining version 1 verification", () => {
    const current = createReleaseProofReceipt(proofInput("local", "demo"))
    expect(RELEASE_PROOF_RECEIPT_VERSION).toBe(2)
    expect(current.schemaVersion).toBe(2)
    if (current.schemaVersion !== 2) throw new Error("Expected a version 2 receipt")

    const {
      receiptDigest: _receiptDigest,
      sharedExecution: _sharedExecution,
      ...currentPayload
    } = current
    const legacyPayload = { ...currentPayload, schemaVersion: 1 as const }
    const legacy = { ...legacyPayload, receiptDigest: digestPayload(legacyPayload) }

    expect(verifyReleaseProofReceipt(legacy)).toEqual(legacy)
  })

  test("writes one atomic self-verifying receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meanwhile-proof-receipt-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "nested", "receipt.json")
    const receipt = createReleaseProofReceipt(proofInput("cloudflare", "pi"))

    await writeReleaseProofReceipt(path, receipt)

    expect(verifyReleaseProofReceipt(await Bun.file(path).json())).toEqual(receipt)
    expect(
      (
        await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true }))
      ).sort(),
    ).toEqual(["nested/receipt.json"])
  })

  test("keeps remote mutation explicit and retains signed clean-revision evidence", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/remote-proof.yml", import.meta.url),
    ).text()
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      scripts: Record<string, string>
    }

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("bun run test:live:cloudflare")
    expect(workflow).toContain("--require-clean")
    expect(workflow).toContain("--commit=")
    expect(workflow).toContain("GITHUB_SHA")
    expect(workflow).toContain("uses: actions/attest@v4")
    expect(workflow).toContain("uses: actions/upload-artifact@v7")
    for (const name of [
      "proof:release",
      "proof:release:cloudflare",
      "proof:release:cloudflare:codex",
      "proof:release:cloudflare:claude",
      "proof:release:cloudflare:pi",
    ]) {
      expect(manifest.scripts[name]).toContain("--output=.proof/")
    }
  })

  test("normalizes proof admission failures before any runtime is created", async () => {
    const child = Bun.spawn(
      [process.execPath, "scripts/release-proof.ts", "--provider=local", "--agent=codex"],
      { stdout: "ignore", stderr: "pipe" },
    )
    const stderr = await new Response(child.stderr).text()

    expect(await child.exited).toBe(1)
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        message: "Credential-bearing agent proofs require the Cloudflare mediation boundary",
        details: {},
      },
    })
    expect(stderr).not.toContain("ProofError")
  })
})

function proofInput(
  provider: "local" | "cloudflare",
  agent: "demo" | "codex" | "claude-code" | "pi",
): Parameters<typeof createReleaseProofReceipt>[0] {
  const fixture = agent === "demo"
  const remote = provider === "cloudflare"
  return {
    proofClass: releaseProofClass(provider, agent),
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    provider,
    agent: {
      type: agent,
      adapter: fixture ? "meanwhile-demo-agent" : `${agent}-acp@1.0.0`,
      runtime: fixture ? "bun@1.3.13" : `${agent}@1.0.0`,
      authenticationEvidence: fixture ? "not-required" : "brokered credential",
      executionEvidence: fixture ? "deterministic-fixture" : "credentialed-live-agent",
      modelIdentityEvidence: fixture ? "not-applicable" : "not-attested",
    },
    revision: { commit: "c".repeat(40), dirty: false },
    provenance: {
      digest: sha256,
      runnerDigest: sha256,
      runtimeImageReference: remote ? "registry.example/meanwhile@sha256:test" : null,
      runtimeImageDigest: remote ? `sha256:${sha256}` : null,
      bridgeProtocolVersion: remote ? 6 : null,
      configuredIdentityComplete: true,
      runnerDigestAuthority: remote ? "operator-asserted" : "measured-local-file",
      runtimeImageDigestAuthority: remote ? "operator-asserted-platform-evidence" : "unavailable",
    },
    credentialBoundary: fixture
      ? {
          mode: "not-required",
          runLeaseId: null,
          sessionLeaseId: null,
          runLeaseRevoked: null,
          sessionLeaseRevoked: null,
          sourceValuesAbsent: true,
        }
      : {
          mode: "brokered",
          runLeaseId: "credential-run",
          sessionLeaseId: "credential-session",
          runLeaseRevoked: true,
          sessionLeaseRevoked: true,
          sourceValuesAbsent: true,
        },
    roundTrip: {
      promptDigest: sha256,
      responseDigest: otherSha256,
      durableResponse: true,
      agentProducedArtifact: true,
      sdkArtifactDownloadVerified: true,
      sdkDeploymentVerified: true,
    },
    sharedExecution: {
      briefId: sha256,
      sourceRunId: "source-run-id",
      sourceArtifactId: sha256,
      sourcePath: "index.html",
      sourceDigest: sha256,
      followUpRunId: "follow-up-run-id",
      followUpArtifactId: otherSha256,
      cleanupAuditId: "follow-up-cleanup-audit",
      credentialLeaseId: fixture ? null : "follow-up-credential-lease",
      credentialLeaseRevoked: fixture ? null : true,
      contextSnapshotVerified: true,
      runnerRevalidationVerified: true,
      semanticReuseVerified: true,
      persistedAfterRestart: true,
      restoredAfterBackup: true,
    },
    session: {
      id: "session-id",
      turns: 2,
      events: 10,
      agentSessionIdentityPreserved: true,
      controlPlaneRestartBetweenTurns: true,
      continuityTokenVerified: true,
      cleanupAuditId: "session-cleanup-audit",
    },
    telemetry: {
      health: "healthy",
      traces: { requests: 1, bytes: 100 },
      metrics: { requests: 1, bytes: 100 },
      structuredLogs: 1,
    },
    run: {
      id: "run-id",
      statusHistory: ["queued", "provisioning", "running", "succeeded"],
      runnerSequence: 3,
      logs: 4,
      cleanupAuditId: "run-cleanup-audit",
    },
    artifact: { id: "artifact-id", digest: sha256, files: 1 },
    deployment: {
      id: "deployment-id",
      target: "local-static",
      previewBoundary: "control-plane-local-static",
      url: "http://127.0.0.1:7332/deployments/example/",
      previewVerifiedAfterRestart: true,
    },
    persistence: {
      restartVerified: true,
      restoreVerified: true,
      privateValuesAbsent: true,
      deploymentLogs: 2,
      auditRecords: 3,
    },
    backup: { digest: sha256, artifacts: 1, deployments: 1, verified: true },
  }
}

function digestPayload(payload: unknown): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalJson(payload)).digest("hex")}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new TypeError("Receipt is not JSON serializable")

  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}
