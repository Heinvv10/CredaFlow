import { describe, it, expect } from "vitest"
import { resolveWaSendMode, isWithinServiceWindow, WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "./send-mode"

const now = new Date("2026-07-24T12:00:00.000Z")
const within = new Date(now.getTime() - 60 * 60 * 1000) // 1h ago
const outside = new Date(now.getTime() - 25 * 60 * 60 * 1000) // 25h ago
const exactly24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)

describe("isWithinServiceWindow", () => {
  it("is true under 24h, false at/over 24h, false when null", () => {
    expect(isWithinServiceWindow(within, now)).toBe(true)
    expect(isWithinServiceWindow(exactly24h, now)).toBe(false)
    expect(isWithinServiceWindow(outside, now)).toBe(false)
    expect(isWithinServiceWindow(null, now)).toBe(false)
  })
})

describe("resolveWaSendMode", () => {
  it("sends free text inside the window even when a template exists", () => {
    expect(resolveWaSendMode({ lastInboundAt: within, hasApprovedTemplate: true, now })).toEqual({ mode: "text" })
  })
  it("sends a template outside the window when one is approved", () => {
    expect(resolveWaSendMode({ lastInboundAt: outside, hasApprovedTemplate: true, now })).toEqual({ mode: "template" })
  })
  it("errors outside the window with no approved template", () => {
    expect(resolveWaSendMode({ lastInboundAt: outside, hasApprovedTemplate: false, now })).toEqual({
      mode: "error",
      error: WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
      providerOutcome: "DEFINITELY_REJECTED",
    })
  })
  it("errors when there was never an inbound and no template", () => {
    expect(resolveWaSendMode({ lastInboundAt: null, hasApprovedTemplate: false, now }).mode).toBe("error")
  })
})
