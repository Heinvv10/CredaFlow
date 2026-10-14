import { beforeEach, describe, expect, it, vi } from "vitest"

const applicationFindUniqueMock = vi.fn()
const txApplicationFindUniqueMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const priorCheckFindManyMock = vi.fn()
const bureauCheckCreateMock = vi.fn()
const complianceRecordCreateMock = vi.fn()
const transactionMock = vi.fn()
const lockApplicationEvidenceMock = vi.fn()
const getCreditReportMock = vi.fn()
const subjectFingerprintMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findUnique: (args: unknown) => applicationFindUniqueMock(args) },
    client: { findUnique: (args: unknown) => clientFindUniqueMock(args) },
    creditBureauCheck: {
      findMany: (args: unknown) => priorCheckFindManyMock(args),
    },
    $transaction: (callback: (tx: unknown) => Promise<unknown>) => transactionMock(callback),
  },
}))
vi.mock("@/lib/affordability/evidence-locks", () => ({
  lockAffordabilityApplicationEvidence: (...args: unknown[]) =>
    lockApplicationEvidenceMock(...args),
}))
vi.mock("@/lib/integrations/experian", () => ({
  getCreditReport: (args: unknown) => getCreditReportMock(args),
}))
vi.mock("@/lib/integrations/experian-input", () => ({
  buildExperianEnquiryInput: (args: unknown) => args,
}))
vi.mock("@/lib/compliance/bureau-subject", () => ({
  bureauSubjectFingerprint: (...args: unknown[]) => subjectFingerprintMock(...args),
}))

import { runBureauReviewCheck } from "./bureau-review"

const request = {
  tenantId: "tenant-1",
  applicationId: "application-1",
  clientId: "client-1",
  reviewGeneration: "review-generation-1",
}

const currentReview = {
  status: "UNDER_REVIEW",
  clientId: "client-1",
  bureauReviewGeneration: "review-generation-1",
}

beforeEach(() => {
  vi.clearAllMocks()
  applicationFindUniqueMock.mockResolvedValue(currentReview)
  txApplicationFindUniqueMock.mockResolvedValue(currentReview)
  clientFindUniqueMock.mockImplementation((args: { select?: Record<string, unknown> }) =>
    args.select?.popiaConsentGiven
      ? Promise.resolve({ popiaConsentGiven: true, consent: null })
      : Promise.resolve({
          idNumber: "9001015800086",
          firstName: "Synthetic",
          lastName: "Applicant",
          gender: "MALE",
          dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        }),
  )
  priorCheckFindManyMock.mockResolvedValue([])
  bureauCheckCreateMock.mockResolvedValue({ id: "bureau-1" })
  complianceRecordCreateMock.mockResolvedValue({ id: "compliance-1" })
  lockApplicationEvidenceMock.mockResolvedValue(undefined)
  subjectFingerprintMock.mockReturnValue("a".repeat(64))
  getCreditReportMock.mockResolvedValue({
    ok: true,
    score: 612,
    riskGrade: "LOW",
    adverseInfo: [],
    totalMonthlyObligations: 25_000,
  })
  transactionMock.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
    loanApplication: { findUnique: txApplicationFindUniqueMock },
    creditBureauCheck: { create: bureauCheckCreateMock },
    complianceRecord: { create: complianceRecordCreateMock },
  }))
})

describe("bureau review generation binding", () => {
  it("does not call the paid provider when the queued generation is already stale", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...currentReview,
      bureauReviewGeneration: "review-generation-2",
    })

    await expect(runBureauReviewCheck(request)).resolves.toBe("stale")

    expect(getCreditReportMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
    expect(bureauCheckCreateMock).not.toHaveBeenCalled()
  })

  it("discards a slow older callback when the application starts a newer review", async () => {
    let resolveProvider!: (value: {
      ok: boolean
      score: number
      riskGrade: string
      adverseInfo: never[]
      totalMonthlyObligations: number
    }) => void
    getCreditReportMock.mockReturnValue(new Promise((resolve) => {
      resolveProvider = resolve
    }))

    const running = runBureauReviewCheck(request)
    await vi.waitFor(() => expect(getCreditReportMock).toHaveBeenCalledOnce())
    txApplicationFindUniqueMock.mockResolvedValue({
      ...currentReview,
      bureauReviewGeneration: "review-generation-2",
    })
    resolveProvider({
      ok: true,
      score: 612,
      riskGrade: "LOW",
      adverseInfo: [],
      totalMonthlyObligations: 25_000,
    })

    await expect(running).resolves.toBe("stale")
    expect(lockApplicationEvidenceMock).toHaveBeenCalled()
    expect(bureauCheckCreateMock).not.toHaveBeenCalled()
    expect(complianceRecordCreateMock).not.toHaveBeenCalled()
  })

  it("stores both bureau and compliance evidence against the current generation", async () => {
    await expect(runBureauReviewCheck(request)).resolves.toBe("stored")

    expect(bureauCheckCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        applicationId: "application-1",
        clientId: "client-1",
        reviewGeneration: "review-generation-1",
        subjectFingerprint: "a".repeat(64),
        obligations: { totalMonthly: 25_000 },
      }),
    })
    expect(complianceRecordCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        referenceId: "application-1",
        data: expect.objectContaining({
          reviewGeneration: "review-generation-1",
        }),
      }),
    })
  })

  it("stores the report's account list beside the total, for the credit checks", async () => {
    const accounts = [{ subscriber: "SYNTHLEND", accountType: "PERSONAL LOAN", instalmentCents: 125_000, status: "OPEN/CURRENT" }]
    getCreditReportMock.mockResolvedValue({ ok: true, score: 612, adverseInfo: [], totalMonthlyObligations: 25_000, accounts })

    await expect(runBureauReviewCheck(request)).resolves.toBe("stored")

    expect(bureauCheckCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ obligations: { totalMonthly: 25_000, accounts } }),
    })
  })

  it("marks a simulated provider response on the stored bureau check", async () => {
    getCreditReportMock.mockResolvedValue({ ok: true, simulated: true, score: 645, adverseInfo: [] })

    await expect(runBureauReviewCheck(request)).resolves.toBe("stored")

    expect(bureauCheckCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ obligations: expect.objectContaining({ simulated: true }) }),
    })
  })

  it("does not mark a genuine provider response as simulated", async () => {
    await runBureauReviewCheck(request)

    const check = bureauCheckCreateMock.mock.calls[0][0].data
    expect(check.obligations).not.toHaveProperty("simulated")
  })

  it("ignores a simulated earlier check when looking for a score drop", async () => {
    getCreditReportMock.mockResolvedValue({ ok: true, score: 520, adverseInfo: [] })
    priorCheckFindManyMock.mockResolvedValue([
      { score: 700, obligations: { simulated: true } },
      { score: 560, obligations: null },
    ])

    await runBureauReviewCheck(request)

    const stored = bureauCheckCreateMock.mock.calls[0][0].data
    expect(stored.obligations).toBeUndefined()
  })

  it("flags a score drop against the latest genuine earlier check", async () => {
    getCreditReportMock.mockResolvedValue({ ok: true, score: 500, adverseInfo: [] })
    priorCheckFindManyMock.mockResolvedValue([
      { score: 700, obligations: { simulated: true } },
      { score: 600, obligations: null },
    ])

    await runBureauReviewCheck(request)

    expect(bureauCheckCreateMock.mock.calls[0][0].data.obligations).toMatchObject({
      scoreDropAlert: { previous: 600, current: 500, drop: 100 },
    })
  })
})
