import { describe, expect, it } from "vitest"
import {
  messageOperationIdempotencyKey,
  parseMessageOperationId,
} from "./request-idempotency"

describe("message request idempotency", () => {
  it("normalises a UUID operation id and rejects arbitrary caller strings", () => {
    expect(parseMessageOperationId(" 11111111-1111-4111-8111-11111111111A "))
      .toBe("11111111-1111-4111-8111-11111111111a")
    expect(parseMessageOperationId("same-message-again")).toBeNull()
    expect(parseMessageOperationId(undefined)).toBeNull()
  })

  it("namespaces the operation so one UUID cannot collide across staff workflows", () => {
    expect(messageOperationIdempotencyKey(
      "agent-message:contact-1:SMS",
      "11111111-1111-4111-8111-111111111111",
    )).toBe("agent-message:contact-1:SMS:11111111-1111-4111-8111-111111111111")
    expect(messageOperationIdempotencyKey("scope", undefined)).toBeUndefined()
    expect(() => messageOperationIdempotencyKey("scope", "bad"))
      .toThrow("Invalid message operation id")
  })
})
