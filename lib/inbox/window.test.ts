import { it, expect } from "vitest"
import { computeWaWindow } from "./window"

const base = new Date("2026-07-05T12:00:00.000Z")

it("is closed with no inbound", () => {
  expect(computeWaWindow(null, base)).toEqual({ open: false, expiresAt: null })
})

it("is open within 24h of last inbound", () => {
  const last = new Date(base.getTime() - 60_000)
  const w = computeWaWindow(last, base)
  expect(w.open).toBe(true)
  expect(w.expiresAt?.toISOString()).toBe(new Date(last.getTime() + 86_400_000).toISOString())
})

it("is closed past 24h", () => {
  const last = new Date(base.getTime() - 86_400_001)
  expect(computeWaWindow(last, base).open).toBe(false)
})
