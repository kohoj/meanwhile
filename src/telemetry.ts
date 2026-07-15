import type {
  Attributes,
  BatchObservableResult,
  Context,
  Counter,
  Histogram,
  Meter,
  ObservableGauge,
  Tracer,
} from "@opentelemetry/api"
import { context, metrics as otelMetrics, SpanStatusCode, trace } from "@opentelemetry/api"
import { SecretRedactor } from "./secrets"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Correlation {
  readonly requestId?: string
  readonly ownerId?: string
  readonly runId?: string
  readonly runtimeId?: string
  readonly processId?: string
  readonly sessionId?: string
  readonly deploymentId?: string
  readonly traceId?: string
  readonly spanId?: string
}

export interface LogSink {
  write(line: string): void
}

export interface TelemetryHealthSnapshot {
  readonly state: "disabled" | "initializing" | "healthy" | "degraded"
  readonly exporter: "disabled" | "initializing" | "healthy" | "degraded"
  readonly lastExportAt?: string
  readonly lastFailureAt?: string
  readonly lastFailureCode?: string
  readonly localLogFailures: number
  readonly localLogHealthy: boolean
  readonly exporters: Readonly<
    Record<
      string,
      {
        readonly state: "initializing" | "healthy" | "degraded"
        readonly lastExportAt?: string
        readonly lastFailureAt?: string
        readonly lastFailureCode?: string
      }
    >
  >
}

interface ExporterHealth {
  state: "initializing" | "healthy" | "degraded"
  lastExportAt?: string
  lastFailureAt?: string
  lastFailureCode?: string
}

export interface ExporterHealthTransition {
  readonly exporter: string
  readonly state: "degraded" | "recovered"
  readonly code?: string
}

export class TelemetryHealth {
  readonly #clock: () => Date
  readonly #exporters = new Map<string, ExporterHealth>()
  #lastExportAt?: string
  #lastFailureAt?: string
  #lastFailureCode?: string
  #localLogFailures = 0
  #localLogHealthy = true
  readonly #exporterListeners = new Set<(transition: ExporterHealthTransition) => void>()

  constructor(
    exporterEnabled: boolean,
    clock: () => Date = () => new Date(),
    exporterNames: readonly string[] = ["default"],
  ) {
    if (exporterEnabled) {
      for (const name of exporterNames) this.#exporters.set(name, { state: "initializing" })
    }
    this.#clock = clock
  }

  exporterReady(name?: string): void {
    if (name === undefined) {
      for (const exporterName of this.#exporters.keys()) {
        const exporter = this.#exporters.get(exporterName)
        if (exporter?.state === "initializing") {
          exporter.state = "healthy"
        }
      }
      return
    }
    this.#assertExporter(name)
    const exporter = this.#exporters.get(name)
    if (exporter?.state === "initializing") {
      exporter.state = "healthy"
    }
  }

  exportSucceeded(name = "default"): void {
    this.#assertExporter(name)
    const at = this.#clock().toISOString()
    const exporter = this.#exporters.get(name) as ExporterHealth
    const recovered = exporter.state === "degraded"
    exporter.state = "healthy"
    exporter.lastExportAt = at
    this.#lastExportAt = at
    if (recovered) this.#notify({ exporter: name, state: "recovered" })
  }

  exportFailed(code: string, name = "default"): void {
    assertStableCode(code)
    this.#assertExporter(name)
    const at = this.#clock().toISOString()
    const exporter = this.#exporters.get(name) as ExporterHealth
    const degraded = exporter.state !== "degraded"
    exporter.state = "degraded"
    exporter.lastFailureAt = at
    exporter.lastFailureCode = code
    this.#lastFailureAt = at
    this.#lastFailureCode = code
    if (degraded) this.#notify({ exporter: name, state: "degraded", code })
  }

  logSinkFailed(): void {
    this.#localLogFailures += 1
    this.#localLogHealthy = false
  }

  logSinkSucceeded(): void {
    this.#localLogHealthy = true
  }

  onExporterTransition(listener: (transition: ExporterHealthTransition) => void): () => void {
    this.#exporterListeners.add(listener)
    return () => this.#exporterListeners.delete(listener)
  }

  snapshot(): TelemetryHealthSnapshot {
    const exporter = this.#exporterState()
    const state = !this.#localLogHealthy || exporter === "degraded" ? "degraded" : exporter

    return {
      state,
      exporter,
      localLogFailures: this.#localLogFailures,
      localLogHealthy: this.#localLogHealthy,
      exporters: Object.fromEntries(
        [...this.#exporters.entries()].map(([name, value]) => [name, { ...value }]),
      ),
      ...(this.#lastExportAt === undefined ? {} : { lastExportAt: this.#lastExportAt }),
      ...(this.#lastFailureAt === undefined ? {} : { lastFailureAt: this.#lastFailureAt }),
      ...(this.#lastFailureCode === undefined ? {} : { lastFailureCode: this.#lastFailureCode }),
    }
  }

  #exporterState(): TelemetryHealthSnapshot["exporter"] {
    if (this.#exporters.size === 0) return "disabled"
    const states = [...this.#exporters.values()].map(({ state }) => state)
    if (states.includes("degraded")) return "degraded"
    if (states.includes("initializing")) return "initializing"
    return "healthy"
  }

  #assertExporter(name: string): void {
    if (!this.#exporters.has(name)) {
      throw new TelemetryContractError(`Telemetry exporter ${JSON.stringify(name)} is unknown`)
    }
  }

  #notify(transition: ExporterHealthTransition): void {
    for (const listener of this.#exporterListeners) {
      try {
        listener(transition)
      } catch {
        // Exporter health remains authoritative when a diagnostic sink fails.
      }
    }
  }
}

export interface StructuredLoggerOptions {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly minimumLevel?: LogLevel
  readonly sink?: LogSink
  readonly clock?: () => Date
  readonly health?: TelemetryHealth
  readonly correlation?: Correlation
  readonly redactor?: SecretRedactor
}

export class StructuredLogger {
  readonly #serviceName: string
  readonly #serviceVersion: string
  readonly #minimumLevel: LogLevel
  readonly #sink: LogSink
  readonly #clock: () => Date
  readonly #health: TelemetryHealth
  readonly #correlation: Correlation
  readonly #redactor: SecretRedactor

  constructor(options: StructuredLoggerOptions) {
    assertStableComponent(options.serviceName, "service name")
    assertServiceVersion(options.serviceVersion)
    assertLogLevel(options.minimumLevel ?? "info")
    const correlation = normalizeCorrelation(options.correlation ?? {})

    this.#serviceName = options.serviceName
    this.#serviceVersion = options.serviceVersion
    this.#minimumLevel = options.minimumLevel ?? "info"
    this.#sink = options.sink ?? consoleLogSink
    this.#clock = options.clock ?? (() => new Date())
    this.#health = options.health ?? new TelemetryHealth(false, this.#clock)
    this.#correlation = correlation
    this.#redactor = options.redactor ?? new SecretRedactor([])
  }

  child(correlation: Correlation, redactor: SecretRedactor = this.#redactor): StructuredLogger {
    return new StructuredLogger({
      serviceName: this.#serviceName,
      serviceVersion: this.#serviceVersion,
      minimumLevel: this.#minimumLevel,
      sink: this.#sink,
      clock: this.#clock,
      health: this.#health,
      correlation: { ...this.#correlation, ...correlation },
      redactor,
    })
  }

  debug(event: string, message: string, attributes?: object): void {
    this.#write("debug", event, message, attributes)
  }

  info(event: string, message: string, attributes?: object): void {
    this.#write("info", event, message, attributes)
  }

  warn(event: string, message: string, attributes?: object): void {
    this.#write("warn", event, message, attributes)
  }

  error(event: string, message: string, attributes?: object): void {
    this.#write("error", event, message, attributes)
  }

  #write(level: LogLevel, event: string, message: string, attributes?: object): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.#minimumLevel]) return
    assertEventName(event)
    try {
      const safeMessage = this.#redactor.redactString(message)
      const safeAttributes =
        attributes === undefined ? undefined : normalizeJson(this.#redactor.redact(attributes))

      const record = {
        timestamp: this.#clock().toISOString(),
        level,
        event,
        service: this.#serviceName,
        serviceVersion: this.#serviceVersion,
        ...this.#correlation,
        message: safeMessage,
        ...(safeAttributes === undefined ? {} : { attributes: safeAttributes }),
      }
      this.#sink.write(JSON.stringify(record))
      this.#health.logSinkSucceeded()
    } catch {
      // Operational output must not change run correctness. Health is the
      // explicit failure channel; the emergency sink has no recursive facade.
      this.#health.logSinkFailed()
      try {
        console.error(
          JSON.stringify({
            timestamp: this.#clock().toISOString(),
            level: "error",
            event: "telemetry.log_sink_failed",
            service: this.#serviceName,
            serviceVersion: this.#serviceVersion,
            message: "Structured log sink failed",
          }),
        )
      } catch {
        // There is no safer in-process output channel after stderr fails.
      }
    }
  }
}

export const METRIC_LABELS = [
  "agent",
  "provider",
  "operation",
  "status",
  "outcome",
  "error.code",
  "signal",
  "artifact.kind",
  "deploy.target",
  "protocol.version",
] as const

export type MetricLabel = (typeof METRIC_LABELS)[number]
export type MetricLabels = Readonly<Partial<Record<MetricLabel, string | number | boolean>>>

export class MetricRecorder {
  readonly #meter: Meter
  readonly #counters = new Map<string, Counter>()
  readonly #histograms = new Map<string, Histogram>()
  readonly #gauges = new Map<string, ObservableGauge>()

  constructor(meter: Meter) {
    this.#meter = meter
  }

  increment(name: string, amount = 1, labels: MetricLabels = {}): void {
    const definition = metricDefinition(name, "counter")
    if (!Number.isFinite(amount) || amount < 0) {
      throw new TelemetryContractError("Counter increments must be finite and non-negative")
    }
    let counter = this.#counters.get(name)
    if (counter === undefined) {
      counter = this.#meter.createCounter(name, {
        unit: definition.unit,
        description: definition.description,
      })
      this.#counters.set(name, counter)
    }
    counter.add(amount, metricAttributes(labels))
  }

  record(name: string, value: number, labels: MetricLabels = {}): void {
    const definition = metricDefinition(name, "histogram")
    if (!Number.isFinite(value)) {
      throw new TelemetryContractError("Histogram values must be finite")
    }
    let histogram = this.#histograms.get(name)
    if (histogram === undefined) {
      histogram = this.#meter.createHistogram(name, {
        unit: definition.unit,
        description: definition.description,
      })
      this.#histograms.set(name, histogram)
    }
    histogram.record(value, metricAttributes(labels))
  }

  observe(
    name: string,
    callback: () => readonly { readonly value: number; readonly labels?: MetricLabels }[],
  ): () => void {
    const definition = metricDefinition(name, "gauge")
    let gauge = this.#gauges.get(name)
    if (gauge === undefined) {
      gauge = this.#meter.createObservableGauge(name, {
        unit: definition.unit,
        description: definition.description,
      })
      this.#gauges.set(name, gauge)
    }
    const observe = (
      result: Parameters<ObservableGauge["addCallback"]>[0] extends (result: infer Result) => void
        ? Result
        : never,
    ): void => {
      for (const measurement of callback()) {
        if (!Number.isFinite(measurement.value) || measurement.value < 0) {
          throw new TelemetryContractError("Gauge observations must be finite and non-negative")
        }
        result.observe(measurement.value, metricAttributes(measurement.labels ?? {}))
      }
    }
    gauge.addCallback(observe)
    return () => gauge?.removeCallback(observe)
  }

  observeBatch(
    names: readonly string[],
    callback: () => Readonly<Record<string, number>>,
  ): () => void {
    const gauges = names.map((name) => {
      const definition = metricDefinition(name, "gauge")
      const existing = this.#gauges.get(name)
      if (existing !== undefined) return existing
      const gauge = this.#meter.createObservableGauge(name, {
        unit: definition.unit,
        description: definition.description,
      })
      this.#gauges.set(name, gauge)
      return gauge
    })
    const observe = (result: BatchObservableResult): void => {
      const values = callback()
      for (let index = 0; index < names.length; index += 1) {
        const name = names[index]
        const gauge = gauges[index]
        if (name === undefined || gauge === undefined) continue
        const value = values[name]
        if (value === undefined || !Number.isFinite(value) || value < 0) {
          throw new TelemetryContractError(
            `Gauge ${JSON.stringify(name)} returned an invalid value`,
          )
        }
        result.observe(gauge, value)
      }
    }
    this.#meter.addBatchObservableCallback(observe, gauges)
    return () => this.#meter.removeBatchObservableCallback(observe, gauges)
  }
}

const METRIC_DEFINITIONS = {
  "meanwhile.run.queue.depth": {
    kind: "gauge",
    unit: "1",
    description: "Queued runs awaiting an executor claim.",
  },
  "meanwhile.run.active": {
    kind: "gauge",
    unit: "1",
    description: "Provisioning or running runs in durable state.",
  },
  "meanwhile.runtime.active": {
    kind: "gauge",
    unit: "1",
    description: "Runtime instances not yet destroyed.",
  },
  "meanwhile.cleanup.backlog": {
    kind: "gauge",
    unit: "1",
    description: "Runtime cleanup records not yet completed.",
  },
  "meanwhile.session.queue.depth": {
    kind: "gauge",
    unit: "1",
    description: "Queued agent sessions awaiting a provisioning claim.",
  },
  "meanwhile.session.active": {
    kind: "gauge",
    unit: "1",
    description: "Provisioning, idle, running, or closing agent sessions.",
  },
  "meanwhile.session.runtime.active": {
    kind: "gauge",
    unit: "1",
    description: "Live runtime leases held by agent sessions.",
  },
  "meanwhile.session.cleanup.backlog": {
    kind: "gauge",
    unit: "1",
    description: "Agent-session runtime leases awaiting destruction.",
  },
  "meanwhile.deployment.running": {
    kind: "gauge",
    unit: "1",
    description: "Deployments in durable running state.",
  },
  "meanwhile.run.outcomes": {
    kind: "counter",
    unit: "1",
    description: "Terminal run outcomes.",
  },
  "meanwhile.session.outcomes": {
    kind: "counter",
    unit: "1",
    description: "Terminal agent-session outcomes.",
  },
  "meanwhile.session.turn.outcomes": {
    kind: "counter",
    unit: "1",
    description: "Terminal agent-session turn outcomes.",
  },
  "meanwhile.log.chunks": {
    kind: "counter",
    unit: "1",
    description: "Accepted durable run log chunks.",
  },
  "meanwhile.log.bytes": {
    kind: "counter",
    unit: "By",
    description: "Accepted durable run log bytes.",
  },
  "meanwhile.artifact.count": {
    kind: "counter",
    unit: "1",
    description: "Persisted immutable artifacts.",
  },
  "meanwhile.artifact.bytes": {
    kind: "counter",
    unit: "By",
    description: "Persisted immutable artifact bytes.",
  },
  "meanwhile.provider.operation.errors": {
    kind: "counter",
    unit: "1",
    description: "Failed runtime-provider operations.",
  },
  "meanwhile.cleanup.events": {
    kind: "counter",
    unit: "1",
    description: "Runtime cleanup lifecycle events.",
  },
  "meanwhile.runtime.provisioning_reconciliation.events": {
    kind: "counter",
    unit: "1",
    description: "Interrupted runtime-provisioning reconciliation events.",
  },
  "meanwhile.deployment.outcomes": {
    kind: "counter",
    unit: "1",
    description: "Terminal deployment outcomes.",
  },
  "meanwhile.run.queue.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Time from run creation until provisioning claim.",
  },
  "meanwhile.run.provision.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Time from provisioning claim until ACP session start.",
  },
  "meanwhile.run.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Time from run creation until terminal state.",
  },
  "meanwhile.run.cancellation.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Time to persist and apply a run cancellation command.",
  },
  "meanwhile.run.timeout.latency": {
    kind: "histogram",
    unit: "ms",
    description: "Delay between a persisted run deadline and timeout claim.",
  },
  "meanwhile.provider.operation.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Runtime-provider operation latency.",
  },
  "meanwhile.cleanup.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Runtime destruction attempt latency.",
  },
  "meanwhile.runtime.provisioning_reconciliation.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Interrupted runtime-provisioning reconciliation latency.",
  },
  "meanwhile.deployment.duration": {
    kind: "histogram",
    unit: "ms",
    description: "Deployment execution latency.",
  },
} as const

type MetricDefinition = (typeof METRIC_DEFINITIONS)[keyof typeof METRIC_DEFINITIONS]

function metricDefinition(name: string, kind: MetricDefinition["kind"]): MetricDefinition {
  assertMetricName(name)
  const definition = METRIC_DEFINITIONS[name as keyof typeof METRIC_DEFINITIONS]
  if (definition === undefined || definition.kind !== kind) {
    throw new TelemetryContractError(`Metric ${JSON.stringify(name)} is not a ${kind}`)
  }
  return definition
}

export const SPAN_ATTRIBUTES = [
  "request.id",
  "owner.id",
  "run.id",
  "runtime.id",
  "process.id",
  "session.id",
  "session.status",
  "session.status_version",
  "turn.id",
  "turn.status",
  "deployment.id",
  "deployment.status",
  "provider.name",
  "provider.operation",
  "agent.type",
  "run.status",
  "run.status_version",
  "runner.sequence",
  "log.sequence",
  "artifact.kind",
  "deploy.target",
  "error.code",
  "decision.branch",
  "config.source",
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "operation.outcome",
] as const

export type SpanAttribute = (typeof SPAN_ATTRIBUTES)[number]
export type SpanAttributes = Readonly<Partial<Record<SpanAttribute, string | number | boolean>>>

export type OperationOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "rejected"
  | "interrupted"

export interface OperationSpan {
  readonly traceId: string | null
  readonly spanId: string | null
  setAttributes(attributes: SpanAttributes): void
  setOutcome(outcome: OperationOutcome, errorCode?: string): void
  child(correlation?: Correlation, redactor?: SecretRedactor): TelemetryScope
}

export interface TelemetryScope {
  readonly logger: StructuredLogger
  readonly metrics: MetricRecorder
  readonly traceId: string | null
  readonly spanId: string | null
  span<T>(
    name: string,
    attributes: SpanAttributes,
    operation: (span: OperationSpan) => T | Promise<T>,
  ): Promise<T>
}

export interface TelemetryOptions extends StructuredLoggerOptions {
  readonly tracer?: Tracer
  readonly meter?: Meter
}

export class Telemetry {
  readonly logger: StructuredLogger
  readonly metrics: MetricRecorder
  readonly health: TelemetryHealth
  readonly #tracer: Tracer
  readonly #meter: Meter
  readonly #options: TelemetryOptions

  constructor(options: TelemetryOptions) {
    this.health = options.health ?? new TelemetryHealth(false, options.clock)
    this.#tracer = options.tracer ?? trace.getTracer(options.serviceName, options.serviceVersion)
    this.#meter = options.meter ?? otelMetrics.getMeter(options.serviceName, options.serviceVersion)
    this.#options = { ...options, health: this.health }
    this.logger = new StructuredLogger(this.#options)
    this.metrics = new MetricRecorder(this.#meter)
  }

  scope(
    correlation: Correlation = {},
    redactor: SecretRedactor = this.#options.redactor ?? new SecretRedactor([]),
  ): TelemetryScope {
    return this.#scope(correlation, redactor)
  }

  span<T>(
    name: string,
    attributes: SpanAttributes,
    operation: (span: OperationSpan) => T | Promise<T>,
  ): Promise<T> {
    return this.#span(name, attributes, this.#options.redactor ?? new SecretRedactor([]), operation)
  }

  #scope(correlation: Correlation, redactor: SecretRedactor, parent?: Context): TelemetryScope {
    const logger = this.logger.child(correlation, redactor)
    return Object.freeze({
      logger,
      metrics: this.metrics,
      traceId: correlation.traceId ?? null,
      spanId: correlation.spanId ?? null,
      span: <T>(
        name: string,
        attributes: SpanAttributes,
        operation: (span: OperationSpan) => T | Promise<T>,
      ) => this.#span(name, attributes, redactor, operation, parent),
    })
  }

  async #span<T>(
    name: string,
    attributes: SpanAttributes,
    redactor: SecretRedactor,
    operation: (span: OperationSpan) => T | Promise<T>,
    parent?: Context,
  ): Promise<T> {
    assertSpanName(name)
    const span = this.#tracer.startSpan(
      name,
      { attributes: spanAttributes(attributes, redactor) },
      parent ?? context.active(),
    )

    const spanContext = trace.setSpan(parent ?? context.active(), span)
    const identity = span.spanContext()
    const traceId = /^0+$/.test(identity.traceId) ? null : identity.traceId
    const spanId = /^0+$/.test(identity.spanId) ? null : identity.spanId
    let ended = false
    let outcomeSet = false
    const facade: OperationSpan = Object.freeze({
      traceId,
      spanId,
      setAttributes: (next: SpanAttributes): void => {
        if (ended) throw new TelemetryContractError("Operation span has already ended")
        span.setAttributes(spanAttributes(next, redactor))
      },
      setOutcome: (outcome: OperationOutcome, errorCode?: string): void => {
        if (ended) throw new TelemetryContractError("Operation span has already ended")
        assertOperationOutcome(outcome)
        if (errorCode !== undefined) assertStableCode(errorCode)
        span.setAttribute("operation.outcome", outcome)
        if (errorCode !== undefined) span.setAttribute("error.code", errorCode)
        if (outcome === "failed" || outcome === "timed_out") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorCode ?? outcome })
        } else if (outcome === "succeeded") {
          span.setStatus({ code: SpanStatusCode.OK })
        } else {
          span.setStatus({ code: SpanStatusCode.UNSET })
        }
        outcomeSet = true
      },
      child: (
        correlation: Correlation = {},
        childRedactor: SecretRedactor = redactor,
      ): TelemetryScope => {
        if (ended) throw new TelemetryContractError("Operation span has already ended")
        return this.#scope(
          {
            ...correlation,
            ...(traceId === null ? {} : { traceId }),
            ...(spanId === null ? {} : { spanId }),
          },
          childRedactor,
          spanContext,
        )
      },
    })

    try {
      const value = await operation(facade)
      if (!outcomeSet) facade.setOutcome("succeeded")
      return value
    } catch (error) {
      const exception = safeException(error)
      span.recordException({ name: exception.name, message: exception.message })
      span.setAttribute("error.code", exception.code)
      span.setAttribute("operation.outcome", "failed")
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.code })
      throw error
    } finally {
      ended = true
      span.end()
    }
  }
}

export class TelemetryContractError extends Error {
  readonly code = "TELEMETRY_CONTRACT_INVALID"

  constructor(message: string) {
    super(message)
    this.name = "TelemetryContractError"
  }
}

export function metricAttributes(labels: Readonly<Record<string, unknown>>): Attributes {
  const allowed = new Set<string>(METRIC_LABELS)
  const output: Attributes = {}

  for (const [key, value] of Object.entries(labels)) {
    if (!allowed.has(key)) {
      throw new TelemetryContractError(`Metric label ${JSON.stringify(key)} is not bounded`)
    }
    assertAttributeValue(value, `Metric label ${key}`, 80)
    output[key] = value
  }
  return output
}

export function spanAttributes(
  attributes: Readonly<Record<string, unknown>>,
  redactor: SecretRedactor = new SecretRedactor([]),
): Attributes {
  const allowed = new Set<string>(SPAN_ATTRIBUTES)
  const output: Attributes = {}

  for (const [key, value] of Object.entries(attributes)) {
    if (!allowed.has(key)) {
      throw new TelemetryContractError(`Span attribute ${JSON.stringify(key)} is not allowed`)
    }
    assertAttributeValue(value, `Span attribute ${key}`, 256)
    output[key] = typeof value === "string" ? redactor.redactString(value) : value
  }
  return output
}

function safeException(error: unknown): {
  readonly name: string
  readonly message: string
  readonly code: string
} {
  if (!(error instanceof Error)) {
    return { name: "Error", message: "Non-Error exception", code: "INTERNAL" }
  }

  const candidateCode = Reflect.get(error, "code")
  const code =
    typeof candidateCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidateCode)
      ? candidateCode
      : "INTERNAL"
  const name = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error.name) ? error.name : "Error"
  return {
    name,
    // Exception messages are an unbounded external-data channel: provider,
    // filesystem, SDK, or database errors can contain paths and values that no
    // operation-scoped redactor knows. Stable codes retain diagnostic grouping
    // without exporting those payloads.
    message: code === "INTERNAL" ? "Internal operation failed" : code,
    code,
  }
}

function normalizeJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`
  if (value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => normalizeJson(entry, seen))

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sensitiveFieldPattern.test(key) ? "[REDACTED]" : normalizeJson(entry, seen)
  }
  return output
}

function normalizeCorrelation(correlation: Correlation): Correlation {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(correlation)) {
    if (value === undefined) continue
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      /[\r\n]/.test(value)
    ) {
      throw new TelemetryContractError(`Correlation field ${key} is invalid`)
    }
    normalized[key] = value
  }
  return Object.freeze(normalized)
}

function assertAttributeValue(
  value: unknown,
  label: string,
  maximumStringLength: number,
): asserts value is string | number | boolean {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TelemetryContractError(`${label} must be finite`)
    }
    return
  }
  if (typeof value === "boolean") return
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumStringLength ||
    /[\r\n]/.test(value)
  ) {
    throw new TelemetryContractError(`${label} has an invalid value`)
  }
}

function assertEventName(value: string): void {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value)) {
    throw new TelemetryContractError("Log event names must be stable dot-separated identifiers")
  }
}

function assertMetricName(value: string): void {
  if (!/^meanwhile(?:\.[a-z][a-z0-9_]*)+$/.test(value)) {
    throw new TelemetryContractError("Metric names must begin with meanwhile.")
  }
}

function assertSpanName(value: string): void {
  if (!/^meanwhile(?:\.[a-z][a-z0-9_-]*)+$/.test(value)) {
    throw new TelemetryContractError("Span names must begin with meanwhile.")
  }
}

function assertStableComponent(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(value)) {
    throw new TelemetryContractError(`${label} is not a stable identifier`)
  }
}

function assertServiceVersion(value: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value)) {
    throw new TelemetryContractError("service version is not a stable identifier")
  }
}

function assertStableCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) {
    throw new TelemetryContractError("Telemetry failure code is invalid")
  }
}

function assertOperationOutcome(value: string): asserts value is OperationOutcome {
  if (!OPERATION_OUTCOMES.has(value as OperationOutcome)) {
    throw new TelemetryContractError("Operation outcome is invalid")
  }
}

function assertLogLevel(value: string): asserts value is LogLevel {
  if (!(value in LOG_LEVEL_PRIORITY)) {
    throw new TelemetryContractError("minimum log level is invalid")
  }
}

const consoleLogSink: LogSink = {
  write(line) {
    console.log(line)
  },
}

const sensitiveFieldPattern =
  /(?:authorization|credential|password|private.?key|secret|token|api.?key)/i

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const OPERATION_OUTCOMES = new Set<OperationOutcome>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "rejected",
  "interrupted",
])
