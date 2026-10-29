import { DEFAULT_SERVICE, logger } from "./logger"
import { scrubbingExporter } from "./span-scrub"

type Env = Partial<Record<string, string>>

/** Off unless an OTLP endpoint is configured (the standard OTEL_* variables), or `OTEL_SDK_DISABLED=true`. */
export function tracingEnabled(env: Env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return false
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim())
}

export interface TracingHandle {
  shutdown(): Promise<void>
}

/**
 * Registers a global OpenTelemetry tracer provider that exports over OTLP/HTTP.
 * Next.js emits its request, render and fetch spans to whatever global provider
 * exists, so registering one is all the server needs. The exporter reads the
 * endpoint, headers, sampler and timeouts from the standard OTEL_* variables.
 * Spans are scrubbed of query strings and path tokens before export (span-scrub.ts).
 * The SDK is imported only when tracing is on, so an unset deploy pays nothing.
 */
export async function startTracing(env: Env = process.env): Promise<TracingHandle | null> {
  if (!tracingEnabled(env)) return null
  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ])
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      "service.version": env.GIT_SHA ?? "unknown",
    }),
    spanProcessors: [new BatchSpanProcessor(scrubbingExporter(new OTLPTraceExporter()))],
  })
  provider.register()
  logger.info("[tracing] OpenTelemetry tracing on", { serviceName })
  return { shutdown: () => provider.shutdown() }
}
