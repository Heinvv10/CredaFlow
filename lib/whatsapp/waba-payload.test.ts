import { describe, it, expect } from "vitest"
import { parseWabaPayload, parseWabaPhoneNumberId, parseWabaStatuses, parseWabaAccountId } from "./waba-payload"

const inbound = {
  entry: [{ changes: [{ value: { messages: [{ from: "27821234567", id: "wamid.X", text: { body: "hi" } }] } }] }],
}

describe("parseWabaPayload", () => {
  it("extracts from/text/id from a Meta inbound envelope", () => {
    expect(parseWabaPayload(inbound)).toEqual({
      fromPhone: "27821234567", text: "hi", providerMessageId: "wamid.X",
    })
  })

  it("returns null for a non-message (status-only) payload", () => {
    expect(parseWabaPayload({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "read" }] } }] }] }))
      .toBeNull()
  })

  it("returns null for junk", () => {
    expect(parseWabaPayload(null)).toBeNull()
    expect(parseWabaPayload({})).toBeNull()
  })

  // Same exposure as parseWabaStatuses: the message branch calls this outside
  // any try/catch (app/api/webhooks/whatsapp-cloud/route.ts:84), so a throw is
  // a 500 on a signed-but-malformed envelope.
  it("returns null (does not throw) for a null entry element", () => {
    expect(() => parseWabaPayload({ entry: [null] })).not.toThrow()
    expect(parseWabaPayload({ entry: [null] })).toBeNull()
  })

  it("returns null (does not throw) for a null changes element", () => {
    expect(() => parseWabaPayload({ entry: [{ changes: [null] }] })).not.toThrow()
    expect(parseWabaPayload({ entry: [{ changes: [null] }] })).toBeNull()
  })

  it("returns null (does not throw) for a null messages element", () => {
    const payload = { entry: [{ changes: [{ value: { messages: [null] } }] }] }
    expect(() => parseWabaPayload(payload)).not.toThrow()
    expect(parseWabaPayload(payload)).toBeNull()
  })

  it("returns null (does not throw) for a null value", () => {
    const payload = { entry: [{ changes: [{ value: null }] }] }
    expect(() => parseWabaPayload(payload)).not.toThrow()
    expect(parseWabaPayload(payload)).toBeNull()
  })

  it("returns null (does not throw) when text is null", () => {
    const payload = { entry: [{ changes: [{ value: { messages: [{ from: "27821234567", text: null }] } }] }] }
    expect(() => parseWabaPayload(payload)).not.toThrow()
    expect(parseWabaPayload(payload)).toBeNull()
  })
})

describe("parseWabaPhoneNumberId", () => {
  it("reads value.metadata.phone_number_id", () => {
    expect(parseWabaPhoneNumberId({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "PN1" }, messages: [] } }] }],
    })).toBe("PN1")
  })
  it("returns null when absent", () => {
    expect(parseWabaPhoneNumberId({ entry: [{ changes: [{ value: {} }] }] })).toBeNull()
    expect(parseWabaPhoneNumberId(null)).toBeNull()
  })

  it("returns null (does not throw) for a null entry element", () => {
    expect(() => parseWabaPhoneNumberId({ entry: [null] })).not.toThrow()
    expect(parseWabaPhoneNumberId({ entry: [null] })).toBeNull()
  })

  it("returns null (does not throw) for a null changes element", () => {
    expect(() => parseWabaPhoneNumberId({ entry: [{ changes: [null] }] })).not.toThrow()
    expect(parseWabaPhoneNumberId({ entry: [{ changes: [null] }] })).toBeNull()
  })
})

describe("parseWabaStatuses", () => {
  it("extracts id + status from a status envelope", () => {
    expect(parseWabaStatuses({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }],
    })).toEqual([{ providerMessageId: "wamid.X", status: "delivered" }])
  })

  it("returns [] for a message-only payload", () => {
    expect(parseWabaStatuses(inbound)).toEqual([])
  })

  // The webhook status branch is NOT wrapped in try/catch, so a throw here is a
  // 500 on a signed-but-malformed payload. Same guard as parseWabaPhoneNumberId.
  it("returns [] (does not throw) for a null entry element", () => {
    expect(() => parseWabaStatuses({ entry: [null] })).not.toThrow()
    expect(parseWabaStatuses({ entry: [null] })).toEqual([])
  })

  it("returns [] (does not throw) for a null changes element", () => {
    expect(() => parseWabaStatuses({ entry: [{ changes: [null] }] })).not.toThrow()
    expect(parseWabaStatuses({ entry: [{ changes: [null] }] })).toEqual([])
  })

  it("returns [] (does not throw) for a null statuses element", () => {
    const payload = { entry: [{ changes: [{ value: { statuses: [null] } }] }] }
    expect(() => parseWabaStatuses(payload)).not.toThrow()
    expect(parseWabaStatuses(payload)).toEqual([])
  })

  it("returns [] (does not throw) for a null value", () => {
    const payload = { entry: [{ changes: [{ value: null }] }] }
    expect(() => parseWabaStatuses(payload)).not.toThrow()
    expect(parseWabaStatuses(payload)).toEqual([])
  })
})

// A message_template_status_update is a WABA-LEVEL event: Meta sends no
// value.metadata.phone_number_id on it, so parseWabaPhoneNumberId returns null
// and the webhook cannot route it by number. `entry[].id` is the WABA id, and
// that is the correct tenant key for these.
describe("parseWabaAccountId", () => {
  it("reads entry[].id", () => {
    expect(parseWabaAccountId({ entry: [{ id: "1000000000000001", changes: [] }] })).toBe("1000000000000001")
  })
  it("returns null for junk", () => {
    expect(parseWabaAccountId(null)).toBeNull()
    expect(parseWabaAccountId({ entry: [] })).toBeNull()
    expect(parseWabaAccountId({ entry: [{ changes: [] }] })).toBeNull()
    expect(parseWabaAccountId({ entry: [{ id: 42 }] })).toBeNull()
  })
})
