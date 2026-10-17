import { describe, expect, it } from "vitest"
import { interestGuidance } from "./interest-guidance"
import { checkNcaInterestRate, ncaCreditType } from "@/lib/loan/nca-interest-cap"
const basis = { day: "2026-10-17", repo: { rate: 0.0825, approved: 0.0825 } }
const input = { productType: "MICRO", amountRand: 8000, termDays: 180, ratePercentPm: 5, interestModel: "FLAT" }
describe("advisory interest check uses approval semantics", () => {
  it.each([
    [8000, 180, "FLAT", 5], [8000.01, 180, "FLAT", 5], [8000, 181, "FLAT", 5],
    [10000, 365, "REDUCING_BALANCE", 3], [10000, 90, "DAILY_ACCRUAL", 2.5],
  ])("classifies R%s / %s days with %s at %s%% just as approval", (amountRand, termDays, interestModel, ratePercentPm) => {
    const result = interestGuidance({ ...input, amountRand, termDays, interestModel, ratePercentPm }, basis)
    const server = checkNcaInterestRate({ creditType: ncaCreditType(Math.round(amountRand * 100), termDays), interestRatePm: ratePercentPm / 100, interestModel, repoAnnualRate: basis.repo.rate })
    expect(result.warning).toBe(!server.ok)
    if (!server.ok) expect(result.message).toBe(server.message)
  })
  it("applies feed cuts, and responds to changed repo rates", () => {
    const unsecured = { ...input, amountRand: 10000, ratePercentPm: 2.5, interestModel: "DAILY_ACCRUAL" }
    expect(interestGuidance(unsecured, { ...basis, repo: { rate: 0.10, approved: 0.10 } }).warning).toBe(false)
    expect(interestGuidance(unsecured, { ...basis, repo: { rate: 0.0825, approved: 0.10 } }).warning).toBe(true)
  })
  it("does not give an unsecured pass with absent or implausible repo records", () => {
    const unsecured = { ...input, amountRand: 10000, ratePercentPm: 1 }
    expect(interestGuidance(unsecured, { ...basis, repo: null }).warning).toBe(true)
    expect(interestGuidance(unsecured, { ...basis, repo: { rate: 2, approved: 2 } }).warning).toBe(true)
  })
  it("defers asset finance to the actual deal regime and checks missing facts", () => {
    expect(interestGuidance({ ...input, productType: "ASSET_FINANCE" }, basis).classification).toBe(null)
    expect(interestGuidance({ ...input, amountRand: 0 }, basis).warning).toBe(true)
  })
})
