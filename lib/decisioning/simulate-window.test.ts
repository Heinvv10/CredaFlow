import { describe, expect, it } from "vitest"
import { parseSimulationWindow } from "./simulate-window"

describe("parseSimulationWindow", () => {
  it("takes nothing, or whole numbers within the bounds", () => {
    expect(parseSimulationWindow({})).toEqual({ ok: true, sinceDays: undefined, limit: undefined })
    expect(parseSimulationWindow({ sinceDays: 1, limit: 1 })).toEqual({ ok: true, sinceDays: 1, limit: 1 })
    expect(parseSimulationWindow({ sinceDays: 730, limit: 500 })).toEqual({ ok: true, sinceDays: 730, limit: 500 })
  })
  it.each([[0], [731], [-5], [1.5], ["30"], [null], [Number.NaN]])("refuses sinceDays %s", (sinceDays) => {
    expect(parseSimulationWindow({ sinceDays })).toMatchObject({ ok: false, error: expect.stringContaining("sinceDays") })
  })
  it.each([[0], [501], [2.5], ["10"]])("refuses limit %s", (limit) => {
    expect(parseSimulationWindow({ limit })).toMatchObject({ ok: false, error: expect.stringContaining("limit") })
  })
})
