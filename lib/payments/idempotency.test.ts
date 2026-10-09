import { describe, expect, it, vi } from "vitest"
import {
  beginPaymentAttempt,
  finishPaymentAttempt,
  parsePaymentIdempotencyKey,
  type PaymentAttemptRef,
} from "./idempotency"

describe("payment idempotency keys", () => {
  it("accepts browser UUIDs and rejects missing, short, or whitespace-bearing keys", () => {
    expect(parsePaymentIdempotencyKey("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    )
    expect(parsePaymentIdempotencyKey(null)).toBeNull()
    expect(parsePaymentIdempotencyKey("too-short")).toBeNull()
    expect(parsePaymentIdempotencyKey("550e8400 e29b 41d4 a716 446655440000")).toBeNull()
  })

  it("blocks a second in-flight submit and reuses the key after a retryable failure", () => {
    const ref: PaymentAttemptRef = { current: null }
    const createKey = vi.fn().mockReturnValueOnce("550e8400-e29b-41d4-a716-446655440000")

    expect(beginPaymentAttempt(ref, "payload-a", createKey)).toBe("550e8400-e29b-41d4-a716-446655440000")
    expect(beginPaymentAttempt(ref, "payload-a", createKey)).toBeNull()
    expect(createKey).toHaveBeenCalledOnce()

    finishPaymentAttempt(ref, false)
    expect(beginPaymentAttempt(ref, "payload-a", createKey)).toBe("550e8400-e29b-41d4-a716-446655440000")
    expect(createKey).toHaveBeenCalledOnce()
  })

  it("creates a new key for changed data and clears the attempt after success", () => {
    const ref: PaymentAttemptRef = { current: null }
    const createKey = vi.fn()
      .mockReturnValueOnce("550e8400-e29b-41d4-a716-446655440000")
      .mockReturnValueOnce("550e8400-e29b-41d4-a716-446655440001")
      .mockReturnValueOnce("550e8400-e29b-41d4-a716-446655440002")

    beginPaymentAttempt(ref, "payload-a", createKey)
    finishPaymentAttempt(ref, false)
    expect(beginPaymentAttempt(ref, "payload-b", createKey)).toBe("550e8400-e29b-41d4-a716-446655440001")
    finishPaymentAttempt(ref, true)
    expect(ref.current).toBeNull()
    expect(beginPaymentAttempt(ref, "payload-b", createKey)).toBe("550e8400-e29b-41d4-a716-446655440002")
  })
})
