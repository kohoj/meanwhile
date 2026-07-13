import type { MetricLabels, TelemetryScope } from "../telemetry"
import type {
  CreateRuntimeInput,
  EventCursor,
  ExposedEndpoint,
  ListRuntimeFilesOptions,
  ProcessEvent,
  ProcessExit,
  ProcessHandle,
  ProcessSignal,
  ProcessSpec,
  ProcessState,
  ProviderHealth,
  ReadRuntimeFileOptions,
  RelativePath,
  RuntimeFile,
  RuntimeFileInfo,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeProviderOperation,
  RuntimeState,
} from "./runtime-provider"
import { RuntimeProviderError } from "./runtime-provider"

/**
 * Adds one provider-neutral observation boundary without exposing telemetry to
 * an adapter. The returned provider preserves the exact compute contract and
 * never changes adapter outcomes when metric recording is unavailable.
 */
export function observeRuntimeProvider(
  provider: RuntimeProvider,
  scope: TelemetryScope,
  attributes: { readonly runId?: string; readonly runtimeId?: string } = {},
  clock: () => number = () => performance.now(),
): RuntimeProvider {
  const observe = <Value>(
    operation: RuntimeProviderOperation,
    execute: () => Promise<Value>,
  ): Promise<Value> =>
    scope.span(
      "meanwhile.provider.operation",
      {
        "provider.name": provider.name,
        "provider.operation": operation,
        ...(attributes.runId === undefined ? {} : { "run.id": attributes.runId }),
        ...(attributes.runtimeId === undefined ? {} : { "runtime.id": attributes.runtimeId }),
      },
      async (span) => {
        const started = clock()
        let status = "succeeded"
        try {
          const value = await execute()
          span.setOutcome("succeeded")
          return value
        } catch (error) {
          status = "failed"
          const code = providerErrorCode(error)
          span.setOutcome("failed", code)
          safeIncrement(scope, "meanwhile.provider.operation.errors", {
            provider: provider.name,
            operation,
            "error.code": code,
          })
          throw error
        } finally {
          safeRecord(scope, "meanwhile.provider.operation.duration", elapsed(clock, started), {
            provider: provider.name,
            operation,
            status,
          })
        }
      },
    )

  const events = async function* (
    process: ProcessHandle,
    cursor: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<ProcessEvent> {
    const started = clock()
    let status = "succeeded"
    try {
      yield* provider.events(process, cursor, signal)
    } catch (error) {
      status = "failed"
      safeIncrement(scope, "meanwhile.provider.operation.errors", {
        provider: provider.name,
        operation: "events",
        "error.code": providerErrorCode(error),
      })
      throw error
    } finally {
      safeRecord(scope, "meanwhile.provider.operation.duration", elapsed(clock, started), {
        provider: provider.name,
        operation: "events",
        status,
      })
    }
  }

  return Object.freeze({
    name: provider.name,
    capabilities: provider.capabilities,
    provenance: provider.provenance,
    create: (input: CreateRuntimeInput): Promise<RuntimeHandle> =>
      observe("create", () => provider.create(input)),
    start: (runtime: RuntimeHandle): Promise<void> =>
      observe("start", () => provider.start(runtime)),
    inspect: (runtime: RuntimeHandle): Promise<RuntimeState> =>
      observe("inspect", () => provider.inspect(runtime)),
    stop: (runtime: RuntimeHandle): Promise<void> => observe("stop", () => provider.stop(runtime)),
    destroy: (runtime: RuntimeHandle): Promise<void> =>
      observe("destroy", () => provider.destroy(runtime)),
    spawn: (runtime: RuntimeHandle, process: ProcessSpec): Promise<ProcessHandle> =>
      observe("spawn", () => provider.spawn(runtime, process)),
    inspectProcess: (process: ProcessHandle): Promise<ProcessState> =>
      observe("inspectProcess", () => provider.inspectProcess(process)),
    events,
    signal: (process: ProcessHandle, signal: ProcessSignal): Promise<void> =>
      observe("signal", () => provider.signal(process, signal)),
    wait: (process: ProcessHandle): Promise<ProcessExit> =>
      observe("wait", () => provider.wait(process)),
    writeFiles: (runtime: RuntimeHandle, files: readonly RuntimeFile[]): Promise<void> =>
      observe("writeFiles", () => provider.writeFiles(runtime, files)),
    listFiles: (
      runtime: RuntimeHandle,
      path: RelativePath,
      options: ListRuntimeFilesOptions,
    ): Promise<RuntimeFileInfo[]> =>
      observe("listFiles", () => provider.listFiles(runtime, path, options)),
    readFile: (
      runtime: RuntimeHandle,
      path: RelativePath,
      options: ReadRuntimeFileOptions,
    ): Promise<Uint8Array> => observe("readFile", () => provider.readFile(runtime, path, options)),
    ...(provider.expose === undefined
      ? {}
      : {
          expose: (runtime: RuntimeHandle, port: number): Promise<ExposedEndpoint> =>
            observe("expose", () => provider.expose?.(runtime, port) as Promise<ExposedEndpoint>),
        }),
    health: (): Promise<ProviderHealth> => observe("health", () => provider.health()),
  })
}

function providerErrorCode(error: unknown): string {
  const candidate = error instanceof RuntimeProviderError ? error.code : "PROVIDER_OPERATION_FAILED"
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : "PROVIDER_OPERATION_FAILED"
}

function elapsed(clock: () => number, started: number): number {
  const value = clock() - started
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function safeIncrement(scope: TelemetryScope, name: string, labels: MetricLabels): void {
  try {
    scope.metrics.increment(name, 1, labels)
  } catch {
    // Telemetry cannot change provider correctness.
  }
}

function safeRecord(
  scope: TelemetryScope,
  name: string,
  value: number,
  labels: MetricLabels,
): void {
  try {
    scope.metrics.record(name, value, labels)
  } catch {
    // Telemetry cannot change provider correctness.
  }
}
