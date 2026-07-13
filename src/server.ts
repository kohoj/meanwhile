import { loadConfig } from "./config"
import { initializeInstrumentation } from "./instrumentation"
import { SERVICE_VERSION } from "./version"

export const startServer = async () => {
  const config = loadConfig()
  const instrumentation = await initializeInstrumentation({
    serviceName: "meanwhile",
    serviceVersion: SERVICE_VERSION,
    environment: Bun.env.NODE_ENV ?? "development",
    logLevel: config.logLevel,
    ...(config.telemetry.enabled && config.telemetry.endpoint !== undefined
      ? { otlp: { endpoint: config.telemetry.endpoint } }
      : {}),
  })

  try {
    // Dynamic import keeps telemetry initialization ahead of application composition.
    const [{ createApplication }, { MAX_TRANSPORT_REQUEST_BODY_BYTES }] = await Promise.all([
      import("./app"),
      import("./api/body"),
    ])
    const application = await createApplication({ config, instrumentation })
    await application.start()
    const server = Bun.serve({
      hostname: config.host,
      port: config.port,
      maxRequestBodySize: MAX_TRANSPORT_REQUEST_BODY_BYTES,
      fetch: application.app.fetch,
    })
    instrumentation.telemetry.logger.info("server.started", "Meanwhile control plane is ready", {
      host: config.host,
      port: server.port,
    })

    let stopping: Promise<void> | null = null
    const stop = (): Promise<void> => {
      if (stopping !== null) return stopping
      stopping = (async () => {
        instrumentation.telemetry.logger.info("server.stopping", "Meanwhile is shutting down")
        await server.stop(true)
        await application.close()
      })()
      return stopping
    }
    const onSignal = () => {
      void stop().then(
        () => {
          process.exitCode = 0
        },
        (error: unknown) => {
          console.error(error)
          process.exitCode = 1
        },
      )
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    return { server, application, stop }
  } catch (error) {
    instrumentation.telemetry.logger.error("server.start_failed", "Meanwhile failed to start", {
      code: error instanceof Error ? error.name : "INTERNAL",
    })
    await instrumentation.shutdown()
    throw error
  }
}

if (import.meta.main) {
  await startServer()
}
