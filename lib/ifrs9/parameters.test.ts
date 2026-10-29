import { describe, expect, it } from "vitest"
import { missingDefaults, parseParameterInput, resolveParameter } from "./parameters"
import type { EclParameter } from "./types"

const row = (scopeKey: string, stage: 1 | 2 | 3, pdBps: number, lgdBps = 4500): EclParameter => ({ scopeKey, stage, pdBps, lgdBps })
const defaults = [row("DEFAULT", 1, 200), row("DEFAULT", 2, 1500), row("DEFAULT", 3, 10_000, 6000)]

describe("resolveParameter", () => {
  const rows = [...defaults, row("CONTRACT:INSTALMENT_SALE", 1, 150), row("PRODUCT:p1", 1, 400), row("PRODUCT:p1", 2, 2500)]

  it("prefers the product, then the contract type, then the lender default", () => {
    expect(resolveParameter(rows, { productId: "p1", contractType: "INSTALMENT_SALE" }, 1)).toMatchObject({ scopeKey: "PRODUCT:p1", pdBps: 400 })
    expect(resolveParameter(rows, { productId: "p2", contractType: "INSTALMENT_SALE" }, 1)).toMatchObject({ scopeKey: "CONTRACT:INSTALMENT_SALE", pdBps: 150 })
    expect(resolveParameter(rows, { productId: "p2", contractType: "LOAN" }, 1)).toMatchObject({ scopeKey: "DEFAULT", pdBps: 200 })
  })

  it("resolves each stage on its own: a product row for Stage 1 does not shadow the default for Stage 3", () => {
    expect(resolveParameter(rows, { productId: "p1", contractType: "LOAN" }, 3)).toMatchObject({ scopeKey: "DEFAULT", pdBps: 10_000, lgdBps: 6000 })
    expect(resolveParameter(rows, { productId: "p1", contractType: "LOAN" }, 2)).toMatchObject({ scopeKey: "PRODUCT:p1", pdBps: 2500 })
  })

  it("is null when no row at all covers the stage", () => {
    expect(resolveParameter([row("PRODUCT:p1", 1, 400)], { productId: "p1", contractType: "LOAN" }, 3)).toBeNull()
  })
})

describe("missingDefaults", () => {
  it("lists the stages the lender default does not cover", () => {
    expect(missingDefaults(defaults)).toEqual([])
    expect(missingDefaults([row("DEFAULT", 1, 200), row("PRODUCT:p1", 2, 900)])).toEqual([2, 3])
  })
})

describe("parseParameterInput", () => {
  const ok = { parameters: [{ scopeKey: "DEFAULT", stage: 1, pdBps: 200, lgdBps: 4500 }, { scopeKey: "PRODUCT:abc", stage: 2, pdBps: 1500, lgdBps: 5000 }] }

  it("accepts a valid table", () => {
    expect(parseParameterInput(ok)).toEqual({ ok: true, rows: ok.parameters })
  })

  it.each([
    [{ parameters: [] }, "non-empty"],
    [{ parameters: [{ scopeKey: "DEFAULT", stage: 4, pdBps: 1, lgdBps: 1 }] }, "stage"],
    [{ parameters: [{ scopeKey: "DEFAULT", stage: 1, pdBps: 10_001, lgdBps: 1 }] }, "pdBps"],
    [{ parameters: [{ scopeKey: "DEFAULT", stage: 1, pdBps: 1.5, lgdBps: 1 }] }, "pdBps"],
    [{ parameters: [{ scopeKey: "DEFAULT", stage: 1, pdBps: 1, lgdBps: -1 }] }, "lgdBps"],
    [{ parameters: [{ scopeKey: "NOPE", stage: 1, pdBps: 1, lgdBps: 1 }] }, "scopeKey"],
    [{ parameters: [{ scopeKey: "CONTRACT:SPACESHIP", stage: 1, pdBps: 1, lgdBps: 1 }] }, "scopeKey"],
    [{ parameters: [{ scopeKey: "DEFAULT", stage: 1, pdBps: 1, lgdBps: 1 }, { scopeKey: "DEFAULT", stage: 1, pdBps: 2, lgdBps: 2 }] }, "twice"],
    [null, "body"],
  ])("refuses %j", (body, fragment) => {
    const result = parseParameterInput(body)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(fragment)
  })
})
