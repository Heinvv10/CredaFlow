import { format } from "node:util"
import { trace } from "@opentelemetry/api"

export type LogLevel = "debug" | "info" | "warn" | "error"

export const DEFAULT_SERVICE = "credaflow"

interface FormatOptions {
  now?: Date
  service?: string
}

const COMPONENT_PREFIX = /^\[([\w.-]+)\]/

/**
 * One log record as a single JSON line. `trace_id`/`span_id` are those of the
 * active OpenTelemetry span (lib/observability/tracing.ts), absent when tracing
 * is off, so a log line can be joined to its trace. `[tag] ...` prefixes, the
 * codebase's console convention, become `component`.
 */
export function formatLogLine(
  level: LogLevel,
  args: readonly unknown[],
  options: FormatOptions = {},
  fields: Record<string, unknown> = {},
): string {
  const message = format(...args)
  const context = trace.getActiveSpan()?.spanContext()
  const traced = context && trace.isSpanContextValid(context) ? { trace_id: context.traceId, span_id: context.spanId } : {}
  const component = COMPONENT_PREFIX.exec(message)?.[1]
  return `${JSON.stringify({
    time: (options.now ?? new Date()).toISOString(),
    level,
    service: options.service ?? process.env.OTEL_SERVICE_NAME ?? DEFAULT_SERVICE,
    ...(component ? { component } : {}),
    message,
    ...traced,
    ...fields,
  })}\n`
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout
  stream.write(formatLogLine(level, [message], {}, fields))
}

/** Structured logger for new code. Always JSON; existing `console.*` calls are covered by json-console.ts. */
export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
}
