import { describe, expect, it } from "vitest"
import {
  SUCCESS_STATUSES,
  TERMINAL_STATUSES,
  statusLabel,
} from "./message-status"

describe("SIMULATED message presentation", () => {
  it("is terminal, explicit, and never treated as delivery success", () => {
    expect(TERMINAL_STATUSES.has("SIMULATED")).toBe(true)
    expect(SUCCESS_STATUSES.has("SIMULATED")).toBe(false)
    expect(statusLabel("SIMULATED")).toBe("Simulated — not sent")
  })

  it("makes a no-replay hold terminal and explicit without treating it as success", () => {
    expect(TERMINAL_STATUSES.has("RECONCILIATION_REQUIRED")).toBe(true)
    expect(SUCCESS_STATUSES.has("RECONCILIATION_REQUIRED")).toBe(false)
    expect(statusLabel("RECONCILIATION_REQUIRED")).toMatch(/manual reconciliation required/i)
  })
})
