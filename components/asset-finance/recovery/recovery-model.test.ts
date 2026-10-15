import { describe, expect, it } from "vitest"
import { canWithdraw, costsOpen, costTreatments, recoveryStepper, type CostAllowLists } from "./recovery-model"

const lists: CostAllowLists = { ncaDeductible: ["TOWING", "STORAGE"], nonNcaChargeable: ["TOWING", "LEGAL_TAXED", "OTHER"] }
const labels = (route: Parameters<typeof recoveryStepper>[0], status: Parameters<typeof recoveryStepper>[1]) => recoveryStepper(route, status)?.map((s) => `${s.state}:${s.key}`)

describe("recoveryStepper", () => {
  it("shows the notice steps on an NCA route and skips them on a non-NCA route", () => {
    expect(labels("NCA_S131_ATTACHMENT", "VALUED")).toEqual([
      "done:RECOVERED", "current:VALUED", "todo:VALUATION_NOTICE_ISSUED", "todo:LISTED", "todo:SOLD", "todo:PROCEEDS_APPLIED", "todo:FINAL_NOTICE_ISSUED", "todo:OUTCOME",
    ])
    expect(labels("NON_NCA_VOLUNTARY", "VALUED")).toEqual(["done:RECOVERED", "current:VALUED", "todo:LISTED", "todo:SOLD", "todo:PROCEEDS_APPLIED", "todo:OUTCOME"])
  })

  it("makes the outcome the current step on a shortfall or surplus and a done one once closed", () => {
    expect(recoveryStepper("NON_NCA_COURT_ORDER", "SHORTFALL_OPEN")?.at(-1)).toMatchObject({ label: "Shortfall open", state: "current" })
    expect(recoveryStepper("NCA_S127_SURRENDER", "SURPLUS_HELD")?.at(-1)).toMatchObject({ label: "Surplus held", state: "current" })
    const closed = recoveryStepper("NCA_S127_SURRENDER", "CLOSED")
    expect(closed?.every((s) => s.state === "done")).toBe(true)
  })

  it("has no path for a withdrawn recovery", () => {
    expect(recoveryStepper("NON_NCA_VOLUNTARY", "WITHDRAWN")).toBeNull()
  })
})

describe("costTreatments", () => {
  it("lets an NCA recovery deduct only the lender's deductible types and charge only taxed legal costs", () => {
    expect(costTreatments("NCA_S131_ATTACHMENT", "TOWING", lists)).toEqual(["DEDUCT_FROM_PROCEEDS"])
    expect(costTreatments("NCA_S127_SURRENDER", "LEGAL_TAXED", lists)).toEqual(["CHARGE_TO_ACCOUNT"])
    expect(costTreatments("NCA_S127_SURRENDER", "OTHER", lists)).toEqual([])
  })

  it("lets a non-NCA recovery do either for its chargeable types", () => {
    expect(costTreatments("NON_NCA_VOLUNTARY", "OTHER", lists)).toEqual(["DEDUCT_FROM_PROCEEDS", "CHARGE_TO_ACCOUNT"])
    expect(costTreatments("NON_NCA_VOLUNTARY", "STORAGE", lists)).toEqual([])
  })
})

describe("status gates", () => {
  it("withdraws until the sale and takes costs until the proceeds are applied", () => {
    expect(canWithdraw("LISTED")).toBe(true)
    expect(canWithdraw("SOLD")).toBe(false)
    expect(costsOpen("SOLD")).toBe(true)
    expect(costsOpen("PROCEEDS_APPLIED")).toBe(false)
  })
})
