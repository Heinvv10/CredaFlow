/**
 * The shared rate-limit store could not answer: the database errored, refused the connection or did not
 * answer in time. Only this trips the limiter's circuit breaker (lib/rate-limit.ts); any other error
 * is a bug in the caller or the store and is rethrown, never absorbed.
 */
export class SharedStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SharedStoreUnavailableError"
  }
}
