import { SecretRedactor } from "./secrets"
import type { LogLevel, LogSink, TelemetryHealthSnapshot } from "./telemetry"
import { StructuredLogger, Telemetry, TelemetryContractError, TelemetryHealth } from "./telemetry"

export interface OtlpHttpConfiguration {
  /** Standard OTEL_EXPORTER_OTLP_ENDPOINT base URL. */
  readonly endpoint: string
  readonly headers?: Readonly<Record<string, string>>
  readonly metricExportIntervalMs?: number
}

export interface InstrumentationConfiguration {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly environment?: string
  readonly logLevel?: LogLevel
  readonly otlp?: OtlpHttpConfiguration
  readonly sink?: LogSink
  readonly clock?: () => Date
}

export interface Instrumentation {
  readonly telemetry: Telemetry
  readonly health: TelemetryHealth
  forceFlush(): Promise<TelemetryHealthSnapshot>
  shutdown(): Promise<TelemetryHealthSnapshot>
}

interface ProviderLifecycle {
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

interface ExportResult {
  readonly code: number
  readonly error?: Error
}

interface ExporterLike {
  export(data: unknown, callback: (result: ExportResult) => void): void
}

/**
 * Initializes only explicit base SDKs and OTLP/HTTP exporters. This module is
 * imported before application modules; the server awaits this function before
 * composing the control plane.
 */
export async function initializeInstrumentation(
  configuration: InstrumentationConfiguration,
): Promise<Instrumentation> {
  const clock = configuration.clock ?? (() => new Date())
  const exporterEnabled = configuration.otlp !== undefined
  const health = new TelemetryHealth(
    exporterEnabled,
    clock,
    exporterEnabled ? ["traces", "metrics"] : [],
  )
  const headerValues = Object.values(configuration.otlp?.headers ?? {}).filter(
    (value) => value.length > 0,
  )
  const redactor = new SecretRedactor(headerValues)

  if (!exporterEnabled) {
    const telemetry = new Telemetry({
      serviceName: configuration.serviceName,
      serviceVersion: configuration.serviceVersion,
      health,
      redactor,
      ...(configuration.logLevel === undefined ? {} : { minimumLevel: configuration.logLevel }),
      ...(configuration.sink === undefined ? {} : { sink: configuration.sink }),
      ...(configuration.clock === undefined ? {} : { clock: configuration.clock }),
    })
    return inertInstrumentation(telemetry, health, redactor)
  }

  const bootstrapLogger = new StructuredLogger({
    serviceName: configuration.serviceName,
    serviceVersion: configuration.serviceVersion,
    health,
    redactor,
    ...(configuration.logLevel === undefined ? {} : { minimumLevel: configuration.logLevel }),
    ...(configuration.sink === undefined ? {} : { sink: configuration.sink }),
    ...(configuration.clock === undefined ? {} : { clock: configuration.clock }),
  })
  const removeHealthListener = health.onExporterTransition((transition) => {
    if (transition.state === "degraded") {
      bootstrapLogger.error("telemetry.export_failed", "Telemetry exporter became degraded", {
        exporter: transition.exporter,
        code: transition.code ?? "TELEMETRY_EXPORT_FAILED",
      })
      return
    }
    bootstrapLogger.info("telemetry.export_recovered", "Telemetry exporter recovered", {
      exporter: transition.exporter,
    })
  })

  try {
    const endpoints = validateOtlpConfiguration(configuration.otlp)
    validateEnvironment(configuration.environment)

    const [
      traceExporterModule,
      metricExporterModule,
      resourcesModule,
      traceSdkModule,
      metricsSdkModule,
    ] = await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/sdk-metrics"),
    ])

    const resource = resourcesModule.resourceFromAttributes({
      "service.name": configuration.serviceName,
      "service.version": configuration.serviceVersion,
      ...(configuration.environment === undefined
        ? {}
        : { "deployment.environment.name": configuration.environment }),
    })

    const traceExporter = observeExporter(
      new traceExporterModule.OTLPTraceExporter({
        url: endpoints.traces,
        headers: { ...configuration.otlp.headers },
      }),
      "traces",
      health,
    )
    const metricExporter = observeExporter(
      new metricExporterModule.OTLPMetricExporter({
        url: endpoints.metrics,
        headers: { ...configuration.otlp.headers },
      }),
      "metrics",
      health,
    )

    const tracerProvider = new traceSdkModule.BasicTracerProvider({
      resource,
      spanProcessors: [new traceSdkModule.BatchSpanProcessor(traceExporter)],
    })
    const metricReader = new metricsSdkModule.PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: configuration.otlp.metricExportIntervalMs ?? 60_000,
    })
    const meterProvider = new metricsSdkModule.MeterProvider({
      resource,
      readers: [metricReader],
    })

    const tracer = tracerProvider.getTracer(configuration.serviceName, configuration.serviceVersion)
    const meter = meterProvider.getMeter(configuration.serviceName, configuration.serviceVersion)
    health.exporterReady()

    const telemetry = new Telemetry({
      serviceName: configuration.serviceName,
      serviceVersion: configuration.serviceVersion,
      health,
      redactor,
      tracer,
      meter,
      ...(configuration.logLevel === undefined ? {} : { minimumLevel: configuration.logLevel }),
      ...(configuration.sink === undefined ? {} : { sink: configuration.sink }),
      ...(configuration.clock === undefined ? {} : { clock: configuration.clock }),
    })
    telemetry.logger.info("telemetry.initialized", "OpenTelemetry exporters initialized", {
      transport: "otlp-http",
    })

    return activeInstrumentation(
      telemetry,
      health,
      redactor,
      tracerProvider,
      meterProvider,
      removeHealthListener,
    )
  } catch (error) {
    health.exportFailed("TELEMETRY_INITIALIZATION_FAILED", "traces")
    health.exportFailed("TELEMETRY_INITIALIZATION_FAILED", "metrics")
    bootstrapLogger.error(
      "telemetry.initialization_failed",
      "OpenTelemetry exporters could not be initialized",
      { error: safeInitializationError(error) },
    )
    const telemetry = new Telemetry({
      serviceName: configuration.serviceName,
      serviceVersion: configuration.serviceVersion,
      health,
      redactor,
      ...(configuration.logLevel === undefined ? {} : { minimumLevel: configuration.logLevel }),
      ...(configuration.sink === undefined ? {} : { sink: configuration.sink }),
      ...(configuration.clock === undefined ? {} : { clock: configuration.clock }),
    })
    return inertInstrumentation(telemetry, health, redactor, removeHealthListener)
  }
}

function activeInstrumentation(
  telemetry: Telemetry,
  health: TelemetryHealth,
  redactor: SecretRedactor,
  tracerProvider: ProviderLifecycle,
  meterProvider: ProviderLifecycle,
  removeHealthListener: () => void,
): Instrumentation {
  let stopped = false

  return {
    telemetry,
    health,
    async forceFlush() {
      if (stopped) return health.snapshot()
      const results = await Promise.allSettled([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
      ])
      if (results[0]?.status === "rejected") {
        health.exportFailed("TELEMETRY_FORCE_FLUSH_FAILED", "traces")
      }
      if (results[1]?.status === "rejected") {
        health.exportFailed("TELEMETRY_FORCE_FLUSH_FAILED", "metrics")
      }
      if (results.some((result) => result.status === "rejected")) {
        telemetry.logger.error(
          "telemetry.force_flush_failed",
          "One or more telemetry providers failed to flush",
        )
      }
      return health.snapshot()
    },
    async shutdown() {
      if (stopped) return health.snapshot()
      stopped = true
      const results = await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
      ])
      if (results[0]?.status === "rejected") {
        health.exportFailed("TELEMETRY_SHUTDOWN_FAILED", "traces")
      }
      if (results[1]?.status === "rejected") {
        health.exportFailed("TELEMETRY_SHUTDOWN_FAILED", "metrics")
      }
      if (results.some((result) => result.status === "rejected")) {
        telemetry.logger.error(
          "telemetry.shutdown_failed",
          "One or more telemetry providers failed to shut down",
        )
      }
      removeHealthListener()
      redactor.dispose()
      return health.snapshot()
    },
  }
}

function inertInstrumentation(
  telemetry: Telemetry,
  health: TelemetryHealth,
  redactor: SecretRedactor,
  removeHealthListener: () => void = () => {},
): Instrumentation {
  let stopped = false
  return {
    telemetry,
    health,
    async forceFlush() {
      return health.snapshot()
    },
    async shutdown() {
      if (!stopped) {
        stopped = true
        removeHealthListener()
        redactor.dispose()
      }
      return health.snapshot()
    },
  }
}

function observeExporter<T extends object>(
  exporter: T,
  name: "traces" | "metrics",
  health: TelemetryHealth,
): T {
  return new Proxy(exporter, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property === "export" && typeof value === "function") {
        return (data: unknown, callback: (result: ExportResult) => void) => {
          let completed = false
          const observedCallback = (result: ExportResult): void => {
            if (completed) return
            completed = true
            if (result.code === 0) health.exportSucceeded(name)
            else health.exportFailed("TELEMETRY_EXPORT_FAILED", name)
            callback(result)
          }

          try {
            ;(value as ExporterLike["export"]).call(target, data, observedCallback)
          } catch (error) {
            if (completed) return
            completed = true
            health.exportFailed("TELEMETRY_EXPORT_FAILED", name)
            callback({
              code: 1,
              error:
                error instanceof Error
                  ? error
                  : new Error("Telemetry exporter threw a non-Error value"),
            })
          }
        }
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function validateEnvironment(environment: string | undefined): void {
  if (environment !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(environment)) {
    throw new TelemetryContractError("Deployment environment is not a stable identifier")
  }
}

function validateOtlpConfiguration(configuration: OtlpHttpConfiguration): {
  readonly traces: string
  readonly metrics: string
} {
  const endpoint = validateEndpoint(configuration.endpoint)
  if (
    configuration.metricExportIntervalMs !== undefined &&
    (!Number.isInteger(configuration.metricExportIntervalMs) ||
      configuration.metricExportIntervalMs < 1_000)
  ) {
    throw new TelemetryContractError(
      "Metric export interval must be an integer of at least 1000 milliseconds",
    )
  }
  for (const [name, value] of Object.entries(configuration.headers ?? {})) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new TelemetryContractError("OTLP header configuration is invalid")
    }
  }
  const basePath = endpoint.pathname.replace(/\/+$/, "")
  const traces = new URL(endpoint)
  traces.pathname = `${basePath}/v1/traces`
  const metrics = new URL(endpoint)
  metrics.pathname = `${basePath}/v1/metrics`
  return { traces: traces.href, metrics: metrics.href }
}

function validateEndpoint(value: string): URL {
  const url = URL.parse(value)
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TelemetryContractError(
      "OTLP endpoint must be an HTTP base URL without credentials, query, or fragment",
    )
  }
  return url
}

function safeInitializationError(error: unknown): Readonly<{ name: string; code: string }> {
  if (!(error instanceof Error)) {
    return { name: "Error", code: "TELEMETRY_INITIALIZATION_FAILED" }
  }
  return {
    name: /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error.name) ? error.name : "Error",
    code: "TELEMETRY_INITIALIZATION_FAILED",
  }
}
