import { beforeEach, describe, expect, it, vi } from "vitest"

const getCreditReportMock = vi.fn()
vi.mock("@/lib/integrations/transunion", () => ({
  getCreditReport: (args: unknown) => getCreditReportMock(args),
}))

import { transunionBureau } from "./transunion"
import { BureauProviderError, type BureauEnquiryRequest } from "../types"

const request: BureauEnquiryRequest = {
  tenantId: "tenant-synthetic",
  consumer: { idNumber: "9001015800088", firstName: "Synthetic", lastName: "Applicant", gender: null, dateOfBirth: null },
  purpose: "AFFORDABILITY_ASSESSMENT",
  consent: { reference: "ClientConsent:synthetic" },
  reference: "application-synthetic",
}
const context = { credentials: null, signal: new AbortController().signal }

beforeEach(() => getCreditReportMock.mockReset())

describe("TransUnion adapter", () => {
  it("passes the tenant and subject to the existing client unchanged", async () => {
    getCreditReportMock.mockResolvedValue({ ok: true, score: 650, adverseInfo: [] })
    await transunionBureau.enquiry(request, context)
    expect(getCreditReportMock).toHaveBeenCalledWith({
      tenantId: "tenant-synthetic", idNumber: "9001015800088", firstName: "Synthetic", lastName: "Applicant",
    })
  })

  it("reports the flags it does not supply as null and claims no score band", async () => {
    getCreditReportMock.mockResolvedValue({
      ok: true, score: 650, riskGrade: "C", adverseInfo: ["SYNTHETIC DEFAULT"], totalMonthlyObligations: 80_000,
      accounts: [{ subscriber: "SYNTHETIC BANK", accountType: null, instalmentCents: 80_000, status: "WHATEVER" }],
    })
    const report = await transunionBureau.enquiry(request, context)
    expect(report).toMatchObject({
      provider: "transunion", deceased: null, underDebtReview: null, hasJudgement: null, hasNotice: null,
      score: { value: 650, band: null }, defaults: ["SYNTHETIC DEFAULT"], statedMonthlyInstalmentCents: 80_000,
    })
    expect(report.tradelines[0].open).toBeNull()
  })

  it("maps 'not configured' to NOT_CONFIGURED and anything else to PROVIDER_ERROR", async () => {
    getCreditReportMock.mockResolvedValueOnce({ ok: false, error: "TransUnion not configured" })
    await expect(transunionBureau.enquiry(request, context)).rejects.toMatchObject({ code: "NOT_CONFIGURED" })
    getCreditReportMock.mockResolvedValueOnce({ ok: false, error: "TransUnion error 503: unavailable" })
    await expect(transunionBureau.enquiry(request, context)).rejects.toBeInstanceOf(BureauProviderError)
  })
})
