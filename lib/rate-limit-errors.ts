/**
 * The shared rate-limit store could not answer this call. Only this is absorbed by the limiter (lib/rate-limit.ts); any
 * other error is a bug in the caller or the store and is rethrown, never hidden.
 *
 *  - "timeout": the call took too long (a lock wait, a statement timeout, no free connection). It concerns THIS
 *    call and says nothing about the database being down: the call is refused or served from memory, and nothing
 *    else changes. A caller that can hold a lock on one key must not be able to switch other keys off.
 *  - "saturated": the limiter's own pool had no free connection in time. It is local congestion, not a statement about
 *    the database: the call is decided by the in-memory limiter, whatever its group, and nothing else changes.
 *  - "error": the database errored or refused the connection. A run of these is an outage and opens the breaker.
 */
export class SharedStoreUnavailableError extends Error {
  readonly kind: "timeout" | "saturated" | "error"

  constructor(message: string, options?: { cause?: unknown; kind?: "timeout" | "saturated" | "error" }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "SharedStoreUnavailableError"
    this.kind = options?.kind ?? "error"
  }
}
