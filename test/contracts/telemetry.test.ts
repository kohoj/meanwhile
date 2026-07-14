import { describe, expect, test } from "bun:test"
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { initializeInstrumentation } from "../../src/instrumentation"
import { SecretRedactor } from "../../src/secrets"
import {
  type Correlation,
  metricAttributes,
  StructuredLogger,
  spanAttributes,
  Telemetry,
  TelemetryContractError,
  TelemetryHealth,
} from "../../src/telemetry"

describe("telemetry contract", () => {
  test("structured logs are correlated JSON and cross the central redactor", () => {
    const lines: string[] = []
    const logger = new StructuredLogger({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0",
      clock: () => new Date("2026-07-13T00:00:00.000Z"),
      sink: { write: (line) => lines.push(line) },
      redactor: new SecretRedactor(["credential-123"]),
    }).child({ requestId: "request_1", runId: "run_1" })

    logger.info("run.transitioned", "credential-123 completed", {
      from: "running",
      to: "succeeded",
      nested: { credential: "credential-123" },
      authorization: "not-registered-with-the-redactor",
    })

    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line).toBeDefined()
    if (line === undefined) throw new Error("Expected one structured log line")
    expect(line).not.toContain("credential-123")
    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-07-13T00:00:00.000Z",
      level: "info",
      event: "run.transitioned",
      service: "meanwhile",
      serviceVersion: "0.1.0",
      requestId: "request_1",
      runId: "run_1",
      message: "[REDACTED] completed",
      attributes: {
        from: "running",
        to: "succeeded",
        nested: { credential: "[REDACTED]" },
        authorization: "[REDACTED]",
      },
    })
  })

  test("minimum log level filters both root and child loggers without weakening redaction", () => {
    const lines: string[] = []
    const logger = new StructuredLogger({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0",
      minimumLevel: "warn",
      clock: () => new Date("2026-07-13T00:00:00.000Z"),
      sink: { write: (line) => lines.push(line) },
      redactor: new SecretRedactor(["credential-123"]),
    })

    logger.debug("test.debug", "filtered")
    logger.info("test.info", "filtered")
    logger.warn("test.warn", "credential-123 warning")
    logger.child({ runId: "run_1" }).info("test.child_info", "filtered")
    logger.child({ runId: "run_1" }).error("test.child_error", "credential-123 failure", {
      token: "credential-123",
    })

    expect(lines).toHaveLength(2)
    const records = lines.map((line) => JSON.parse(line))
    expect(records.map((record) => record.level)).toEqual(["warn", "error"])
    expect(records[1]).toMatchObject({
      runId: "run_1",
      message: "[REDACTED] failure",
      attributes: { token: "[REDACTED]" },
    })
    expect(lines.join("\n")).not.toContain("credential-123")
  })

  test("canonicalizes unavailable optional correlation without hiding the log event", () => {
    const lines: string[] = []
    const logger = new StructuredLogger({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0",
      sink: { write: (line) => lines.push(line) },
    })

    logger
      .child({ requestId: undefined, runId: "run_1" } as unknown as Correlation)
      .error("run.failed", "Run failed")

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "run.failed",
      runId: "run_1",
      message: "Run failed",
    })
    expect(lines[0]).not.toContain("requestId")
  })

  test("instrumentation propagates its configured minimum log level", async () => {
    const lines: string[] = []
    const instrumentation = await initializeInstrumentation({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0-test",
      logLevel: "error",
      sink: { write: (line) => lines.push(line) },
    })

    instrumentation.telemetry.logger.warn("test.warn", "filtered")
    instrumentation.telemetry.logger.error("test.error", "visible")

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "error",
      event: "test.error",
      message: "visible",
    })
    await instrumentation.shutdown()
  })

  test("metric labels and span attributes use explicit cardinality boundaries", async () => {
    expect(() => metricAttributes({ "owner.id": "owner_1" })).toThrow(TelemetryContractError)
    expect(() => metricAttributes({ provider: "cloudflare" })).not.toThrow()
    expect(() => spanAttributes({ prompt: "ship it" })).toThrow(TelemetryContractError)

    const telemetry = new Telemetry({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0",
      sink: { write() {} },
    })
    telemetry.metrics.increment("meanwhile.run.outcomes", 1, {
      provider: "local",
      status: "succeeded",
    })
    telemetry.metrics.increment("meanwhile.runtime.provisioning_reconciliation.events", 1, {
      provider: "local",
      status: "reconciled",
    })
    telemetry.metrics.record("meanwhile.runtime.provisioning_reconciliation.duration", 1, {
      provider: "local",
      status: "reconciled",
    })
    await telemetry.span(
      "meanwhile.provider.operation",
      { "provider.name": "local", "run.id": "run_1" },
      () => "done",
    )
  })

  test("explicit child scopes preserve trace hierarchy under Bun without async context", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    const lines: string[] = []
    const telemetry = new Telemetry({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0-test",
      tracer: provider.getTracer("meanwhile", "0.1.0-test"),
      sink: { write: (line) => lines.push(line) },
    })

    await telemetry.span("meanwhile.run.execute", { "run.id": "run_1" }, async (outer) => {
      expect("setAttribute" in outer).toBe(false)
      expect("spanContext" in outer).toBe(false)
      const child = outer.child({ runId: "run_1" })
      child.logger.info("run.child_scope", "Child scope is correlated")
      await child.span(
        "meanwhile.provider.operation",
        { "provider.name": "local", "provider.operation": "inspect" },
        (inner) => {
          inner.setOutcome("failed", "PROVIDER_UNAVAILABLE")
        },
      )
    })
    await provider.forceFlush()

    const spans = exporter.getFinishedSpans()
    const outer = spans.find(({ name }) => name === "meanwhile.run.execute")
    const inner = spans.find(({ name }) => name === "meanwhile.provider.operation")
    expect(outer).toBeDefined()
    expect(inner).toBeDefined()
    expect(inner?.spanContext().traceId).toBe(outer?.spanContext().traceId)
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId)
    expect(inner?.attributes).toMatchObject({
      "operation.outcome": "failed",
      "error.code": "PROVIDER_UNAVAILABLE",
    })
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      runId: "run_1",
      traceId: outer?.spanContext().traceId,
      spanId: outer?.spanContext().spanId,
    })
    await provider.shutdown()
  })

  test("fixed metric instruments export explicit units and descriptions", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    })
    const provider = new MeterProvider({ readers: [reader] })
    const telemetry = new Telemetry({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0-test",
      meter: provider.getMeter("meanwhile", "0.1.0-test"),
      sink: { write() {} },
    })
    telemetry.metrics.increment("meanwhile.log.bytes", 2)
    telemetry.metrics.record("meanwhile.run.duration", 3)
    await provider.forceFlush()

    const descriptors = exporter
      .getMetrics()
      .flatMap(({ scopeMetrics }) => scopeMetrics.flatMap(({ metrics }) => metrics))
      .map(({ descriptor }) => descriptor)
    expect(descriptors).toContainEqual(
      expect.objectContaining({
        name: "meanwhile.log.bytes",
        unit: "By",
        description: "Accepted durable run log bytes.",
      }),
    )
    expect(descriptors).toContainEqual(
      expect.objectContaining({
        name: "meanwhile.run.duration",
        unit: "ms",
        description: "Time from run creation until terminal state.",
      }),
    )
    await provider.shutdown()
  })

  test("one exporter recovery cannot hide another exporter failure", () => {
    const health = new TelemetryHealth(true, () => new Date("2026-07-13T00:00:00.000Z"), [
      "traces",
      "metrics",
    ])
    health.exporterReady()
    health.exportFailed("TELEMETRY_EXPORT_FAILED", "traces")
    health.exportSucceeded("metrics")
    expect(health.snapshot()).toMatchObject({
      state: "degraded",
      exporters: {
        traces: { state: "degraded", lastFailureCode: "TELEMETRY_EXPORT_FAILED" },
        metrics: { state: "healthy" },
      },
    })

    health.exportSucceeded("traces")
    expect(health.snapshot()).toMatchObject({
      state: "healthy",
      exporter: "healthy",
      lastFailureCode: "TELEMETRY_EXPORT_FAILED",
    })
  })

  test("exporter health emits only bounded state transitions", () => {
    const transitions: unknown[] = []
    const health = new TelemetryHealth(true, () => new Date("2026-07-13T00:00:00.000Z"), ["traces"])
    health.onExporterTransition((transition) => transitions.push(transition))
    health.exporterReady("traces")
    health.exportFailed("TELEMETRY_EXPORT_FAILED", "traces")
    health.exportFailed("TELEMETRY_EXPORT_FAILED", "traces")
    health.exportSucceeded("traces")
    health.exportSucceeded("traces")
    expect(transitions).toEqual([
      { exporter: "traces", state: "degraded", code: "TELEMETRY_EXPORT_FAILED" },
      { exporter: "traces", state: "recovered" },
    ])
  })

  test("invalid exporter configuration degrades safely without exposing credentials", async () => {
    const logs: string[] = []
    const instrumentation = await initializeInstrumentation({
      serviceName: "meanwhile",
      serviceVersion: "0.1.0-test",
      sink: { write: (line) => logs.push(line) },
      otlp: {
        endpoint: "https://collector-user:collector-password@example.test",
      },
    })

    expect(instrumentation.health.snapshot()).toMatchObject({
      state: "degraded",
      exporter: "degraded",
      lastFailureCode: "TELEMETRY_INITIALIZATION_FAILED",
    })
    expect(logs.join("\n")).not.toContain("collector-user")
    expect(logs.join("\n")).not.toContain("collector-password")
    await instrumentation.shutdown()
  })

  test("pinned base SDK and OTLP HTTP exporters initialize and export under Bun", async () => {
    const requests: Array<{ path: string; bytes: number }> = []
    const logs: string[] = []
    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          bytes: (await request.arrayBuffer()).byteLength,
        })
        return new Response(null, { status: 200 })
      },
    })

    try {
      const instrumentation = await initializeInstrumentation({
        serviceName: "meanwhile",
        serviceVersion: "0.1.0-test",
        environment: "test",
        sink: { write: (line) => logs.push(line) },
        otlp: {
          endpoint: collector.url.href,
          metricExportIntervalMs: 60_000,
        },
      })

      await instrumentation.telemetry.span(
        "meanwhile.test.export",
        { "provider.name": "contract-test" },
        () => undefined,
      )
      instrumentation.telemetry.metrics.increment("meanwhile.run.outcomes", 1, {
        provider: "contract-test",
        outcome: "succeeded",
      })

      const health = await instrumentation.forceFlush()
      expect(health.state).toBe("healthy")
      expect(requests.some((request) => request.path === "/v1/traces")).toBe(true)
      expect(requests.some((request) => request.path === "/v1/metrics")).toBe(true)
      expect(requests.every((request) => request.bytes > 0)).toBe(true)
      expect(logs.join("\n")).not.toContain("undefined")

      await instrumentation.shutdown()
    } finally {
      collector.stop(true)
    }
  }, 10_000)
})
