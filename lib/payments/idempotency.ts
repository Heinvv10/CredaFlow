export const PAYMENT_IDEMPOTENCY_HEADER = "Idempotency-Key"

const PAYMENT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/

/** Accept an opaque printable key while excluding whitespace/control bytes. */
export function parsePaymentIdempotencyKey(value: string | null): string | null {
  if (!value) return null
  const key = value.trim()
  return PAYMENT_IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null
}

export interface PaymentAttempt {
  key: string
  signature: string
  inFlight: boolean
}

export interface PaymentAttemptRef {
  current: PaymentAttempt | null
}

/**
 * Synchronously claims one browser submission. React state updates are not
 * synchronous, so the ref is the authority that closes the double-click gap.
 * A failed/network-lost retry with unchanged data reuses the same key.
 */
export function beginPaymentAttempt(
  ref: PaymentAttemptRef,
  signature: string,
  createKey: () => string = () => globalThis.crypto.randomUUID(),
): string | null {
  if (ref.current?.inFlight) return null
  if (!ref.current || ref.current.signature !== signature) {
    ref.current = { key: createKey(), signature, inFlight: false }
  }
  ref.current.inFlight = true
  return ref.current.key
}

export function finishPaymentAttempt(ref: PaymentAttemptRef, completed: boolean): void {
  if (!ref.current) return
  if (completed) {
    ref.current = null
    return
  }
  ref.current.inFlight = false
}
