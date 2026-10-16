import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

const lenderIdentityMocks = vi.hoisted(() => ({ get: vi.fn(), find: vi.fn() }))
// No tenant logo: documents print the text letterhead (lib/config/lender-logo.ts).
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: async () => undefined }))
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  const identity = actual.parseLenderIdentity(VALID_LENDER_COLUMNS)
  lenderIdentityMocks.get.mockResolvedValue(identity)
  lenderIdentityMocks.find.mockResolvedValue(identity)
  return {
    ...actual,
    getLenderIdentity: (...args: unknown[]) => lenderIdentityMocks.get(...args),
    findLenderIdentity: (...args: unknown[]) => lenderIdentityMocks.find(...args),
  }
})
vi.mock("@/lib/prisma", () => ({
  prisma: {
    documentTemplate: { findMany: vi.fn() },
    loanProduct: { findUnique: vi.fn() },
    loanApplication: { findUnique: vi.fn() },
    repaymentSchedule: { findFirst: vi.fn(), findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    insurancePolicy: { findFirst: vi.fn() },
  },
}))

vi.mock("@/lib/pdf/creditAgreement", () => ({ generateCreditAgreementPdf: vi.fn() }))
// The quotation's own evidence is verified in lib/compliance/pasq.test.ts; here
// only whether the adapter takes credit-life terms from it.
const { pasqIntact } = vi.hoisted(() => ({ pasqIntact: vi.fn(() => true) }))
vi.mock("@/lib/compliance/pasq", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/pasq")>()),
  pasqEvidenceIsIntact: () => pasqIntact(),
}))
vi.mock("@/lib/pdf/debitMandate", () => ({ generateDebitMandatePdf: vi.fn() }))
vi.mock("@/lib/collections/section129-artifact", () => ({ loadIssuedSection129Artifact: vi.fn() }))
// Default-charge figures are exercised in lib/loan/charges-summary.test.ts and
// against real Postgres; here they are the no-charges case.
vi.mock("@/lib/loan/charges-summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/charges-summary")>()),
  loanSettlementFigures: vi.fn(async () => ({
    live: false, charges: null, chargeLines: [], chargesOutstanding: 0, totalToSettle: 0,
    interestAndFeesOutstanding: 0, arrearsIncludingCharges: 0, paymentsReceived: 0,
  })),
}))
vi.mock("@/lib/pdf/certificateOfBalance", () => ({ generateCertificateOfBalancePdf: vi.fn() }))
vi.mock("@/lib/pdf/faisDisclosure", () => ({ generateFaisDisclosurePdf: vi.fn() }))
vi.mock("@/lib/pdf/statement", () => ({ generateStatementPdf: vi.fn() }))
vi.mock("@/lib/config/debit-mandate", () => ({
  assertDebitMandateCreditorTenant: vi.fn(),
  getDebitMandateCreditorBankDetails: () => ({
    bankName: "Provider Bank",
    accountNumber: "9999999999",
    branchCode: "250655",
  }),
}))
vi.mock("@/lib/compliance/sa-business-calendar.server", () => ({
  quotationValidUntilDateFromDatabase: vi.fn().mockResolvedValue("2026-07-30"),
}))

import { prisma } from "@/lib/prisma"
import { generateCreditAgreementPdf } from "@/lib/pdf/creditAgreement"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
} from "@/lib/insurance/credit-life-election.server"
import { generateDebitMandatePdf } from "@/lib/pdf/debitMandate"
import { loadIssuedSection129Artifact } from "@/lib/collections/section129-artifact"
import { generateCertificateOfBalancePdf } from "@/lib/pdf/certificateOfBalance"
import { generateFaisDisclosurePdf } from "@/lib/pdf/faisDisclosure"
import { generateStatementPdf } from "@/lib/pdf/statement"
import { createDebitMandateTestEvidence } from "@/lib/loan/__fixtures__/debit-mandate"
import {
  listTemplates,
  listGeneratableCustomTemplates,
  isTemplateEligibleForContext,
  SYSTEM_GENERATORS,
  SystemGeneratorUnavailableError,
  type SystemDocContext,
} from "./catalogue"

const ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED =
  process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED

beforeEach(() => {
  delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  vi.clearAllMocks()
})

afterEach(() => {
  if (ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED === undefined) {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  } else {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  }
})

const tenant = { id: "t1", slug: "acme", name: "Acme Lending" }
const client = {
  id: "c1",
  firstName: "Thabo",
  lastName: "M",
  idNumber: "9001015800081",
  email: "thabo@example.com",
  phone: "0821234567",
  addressLine1: "12 Main Street",
  city: "Pretoria",
  bankName: "Test Bank",
  bankBranchCode: "000001",
  bankAccountNumber: "1234567890",
  accountType: "CHEQUE",
}

function ctx(extra: Partial<SystemDocContext> = {}): SystemDocContext {
  return { tenant, client, ...extra } as unknown as SystemDocContext
}

/** A stored, verifiable credit-life record: an offer the consumer DECLINED (or ACCEPTED). */
function declinedOffer(principalCents: number, termDays: number, election: "DECLINED" | "ACCEPTED" = "DECLINED") {
  const offer = {
    version: "credit-life-election-v1" as const, election, principalCents, termDays,
    monthlyPremiumCents: Math.floor((principalCents * 45 + 5_000) / 10_000),
    productId: "cl-1", productName: "Synthetic Credit Life", insurerId: "ins-1", insurerName: "Synthetic Insurer",
  }
  return {
    creditLifeElection: offer.election,
    creditLifeProductId: offer.productId,
    creditLifeProductName: offer.productName,
    creditLifeInsurerId: offer.insurerId,
    creditLifeInsurerName: offer.insurerName,
    creditLifeMonthlyPremiumCents: offer.monthlyPremiumCents,
    creditLifeDisclosureVersion: offer.version,
    creditLifeDisclosureSha256: createCreditLifeDisclosureSha256(offer),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-28T09:50:00.000Z"),
    creditLifeDisclosureAcknowledgedBy: "c1",
  }
}

describe("listTemplates", () => {
  it("queries by tenantId, excludes soft-deleted, orders by name", async () => {
    const rows = [{ id: "d1", name: "Certificate of Balance" }]
    vi.mocked(prisma.documentTemplate.findMany).mockResolvedValue(rows as never)

    const result = await listTemplates("t1")

    expect(prisma.documentTemplate.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", deletedAt: null },
      orderBy: { name: "asc" },
      include: {
        versions: {
          where: { status: "ACTIVE" },
          select: { id: true },
        },
      },
    })
    expect(result).toBe(rows)
  })
})

describe("listGeneratableCustomTemplates", () => {
  it("returns only a custom template with an ACTIVE current version that fits client context", async () => {
    vi.mocked(prisma.documentTemplate.findMany).mockResolvedValue([
      {
        id: "published",
        key: "welcome",
        isActive: true,
        currentVersionId: "v1",
        versions: [{ id: "v1", tokensUsed: ["client.fullName", "today"] }],
      },
      {
        id: "dangling",
        key: "dangling",
        isActive: true,
        currentVersionId: "v2",
        versions: [{ id: "old", tokensUsed: [] }],
      },
      {
        id: "needs-app",
        key: "application-letter",
        isActive: true,
        currentVersionId: "v3",
        versions: [{ id: "v3", tokensUsed: ["application.reference"] }],
      },
    ] as never)

    await expect(listGeneratableCustomTemplates("t1", { client: true })).resolves.toEqual([
      expect.objectContaining({ id: "published", key: "welcome" }),
    ])

    expect(prisma.documentTemplate.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        kind: "CUSTOM",
        isActive: true,
        deletedAt: null,
        currentVersionId: { not: null },
      },
      orderBy: { name: "asc" },
      include: {
        versions: {
          where: { status: "ACTIVE" },
          select: { id: true, tokensUsed: true },
        },
      },
    })
  })

  it("requires application and loan context for their token namespaces", () => {
    expect(isTemplateEligibleForContext(["application.reference"], { client: true })).toBe(false)
    expect(isTemplateEligibleForContext(["loan.reference"], { client: true, application: true })).toBe(false)
    expect(isTemplateEligibleForContext({ invalid: "metadata" }, { client: true })).toBe(false)
    expect(isTemplateEligibleForContext(["application.reference", "loan.reference"], {
      client: true,
      application: true,
      loan: true,
    })).toBe(true)
  })
})

describe("SYSTEM_GENERATORS", () => {
  it("has all 8 seeded systemGenerator keys", () => {
    expect(Object.keys(SYSTEM_GENERATORS).sort()).toEqual([
      "affordabilityAssessment",
      "certificateOfBalance",
      "creditAgreement",
      "debitMandate",
      "faisDisclosure",
      "preAgreement",
      "section129",
      "statement",
    ])
  })

  it("creditAgreement calls the mocked generator and returns its Buffer", async () => {
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({
      id: "p1",
      interestRatePm: 0.05,
      interestModel: "FLAT",
      initiationFeePct: 0.1,
      initiationFeeMax: 0,
      monthlyServiceFee: 6900,
    } as never)
    const pdf = Buffer.from("credit-agreement")
    vi.mocked(generateCreditAgreementPdf).mockResolvedValue(pdf)

    const application = {
      productId: "p1",
      appliedAmount: 500000,
      appliedTermDays: 30,
      initiationFeePayment: "DEFERRED",
      reference: "APP-0001",
      agreementType: null,
      // The agreement variant recites the consumer acknowledgement — the
      // adapter refuses to render without the ceremony evidence.
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      pasqDocumentSha256: "d".repeat(64),
      pasqAcknowledgedSha256: "d".repeat(64),
      pasqEvidence: {
        calculator: { startDate: "2026-07-28T09:55:00.000Z" },
        creditLife: { premiumPeriods: 1, totalPremiumCents: 0 },
        billing: { schedule: [] },
      },
      // A DECLINED offer: still an offer, never "Credit Life: Not offered".
      ...declinedOffer(500000, 30),
    }

    const result = await SYSTEM_GENERATORS.creditAgreement(ctx({ application: application as never }))

    expect(generateCreditAgreementPdf).toHaveBeenCalledTimes(1)
    // The presented date must be the acknowledged PASQ's own instant, never "now".
    expect(generateCreditAgreementPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "agreement",
        quotePresentedAt: new Date("2026-07-28T09:55:00.000Z"),
      }),
    )
    expect(generateCreditAgreementPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          firstName: "Thabo",
          lastName: "M",
          idNumber: "9001015800081",
        }),
        application: expect.objectContaining({ reference: "APP-0001" }),
        // calc.principal passes through calculateLoan() unconverted — still
        // cents, not the raw appliedAmount re-derived some other way.
        calc: expect.objectContaining({ principal: 500000 }),
        willAutoBundleCl: false,
        creditLifeNotOffered: false,
        creditLife: expect.objectContaining({ elected: false, productName: "Synthetic Credit Life", insurerName: "Synthetic Insurer" }),
      })
    )
    expect(result).toBe(pdf)
  })

  it("creditAgreement prints 'not offered' only from a stored no-offer record", async () => {
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({
      id: "p1", interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.1, initiationFeeMax: 0, monthlyServiceFee: 6900,
    } as never)
    vi.mocked(generateCreditAgreementPdf).mockResolvedValue(Buffer.from("credit-agreement"))
    const application = {
      productId: "p1", appliedAmount: 500000, appliedTermDays: 30, initiationFeePayment: "DEFERRED",
      reference: "APP-0002", agreementType: null,
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      pasqDocumentSha256: "d".repeat(64), pasqAcknowledgedSha256: "d".repeat(64),
      pasqEvidence: { calculator: { startDate: "2026-07-28T09:55:00.000Z" } },
      creditLifeElection: "DECLINED",
      creditLifeProductId: null, creditLifeProductName: null, creditLifeInsurerId: null, creditLifeInsurerName: null,
      creditLifeMonthlyPremiumCents: 0,
      creditLifeDisclosureVersion: "credit-life-no-offer-v1",
      creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
        version: "credit-life-no-offer-v1", election: "DECLINED", principalCents: 500000, termDays: 30,
      }),
      creditLifeDisclosureAcknowledgedAt: new Date("2026-07-28T09:50:00.000Z"),
      creditLifeDisclosureAcknowledgedBy: "c1",
    }

    await SYSTEM_GENERATORS.creditAgreement(ctx({ application: application as never }))

    const args = vi.mocked(generateCreditAgreementPdf).mock.calls.at(-1)![0]
    expect(args.creditLifeNotOffered).toBe(true)
    expect(args.creditLife).toBeUndefined()
  })

  // Matches POST /agreement: an accepted election whose cover can no longer be
  // added (auto-bundling off) is refused, never printed as accepted cover with
  // the auto-bundle disclosure switched off.
  describe("accepted election", () => {
    const accepted = () => ({
      productId: "p1", appliedAmount: 500000, appliedTermDays: 30, initiationFeePayment: "DEFERRED",
      reference: "APP-0005", agreementType: null,
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      pasqDocumentSha256: "d".repeat(64), pasqAcknowledgedSha256: "d".repeat(64),
      pasqEvidence: {
        calculator: { startDate: "2026-07-28T09:55:00.000Z" },
        creditLife: { premiumPeriods: 1, totalPremiumCents: 2_250 },
        billing: { schedule: [] },
      },
      ...declinedOffer(500000, 30, "ACCEPTED"),
    })
    beforeEach(() => {
      vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({
        id: "p1", interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.1, initiationFeeMax: 0, monthlyServiceFee: 6900,
      } as never)
      vi.mocked(generateCreditAgreementPdf).mockClear().mockResolvedValue(Buffer.from("credit-agreement"))
    })
    afterEach(() => { vi.unstubAllEnvs() })

    it("refuses when the accepted cover is no longer eligible", async () => {
      vi.stubEnv("CREDIT_LIFE_AUTO_BUNDLE_ENABLED", "")
      await expect(SYSTEM_GENERATORS.creditAgreement(ctx({ application: accepted() as never })))
        .rejects.toThrow(/accepted credit-life election is no longer available/)
      expect(generateCreditAgreementPdf).not.toHaveBeenCalled()
    })

    it("prints the accepted cover with its disclosure when still eligible", async () => {
      vi.stubEnv("CREDIT_LIFE_AUTO_BUNDLE_ENABLED", "true")
      await SYSTEM_GENERATORS.creditAgreement(ctx({ application: accepted() as never }))
      expect(generateCreditAgreementPdf).toHaveBeenCalledWith(expect.objectContaining({
        willAutoBundleCl: true,
        creditLifeNotOffered: false,
        creditLife: expect.objectContaining({ elected: true, totalPremiumCents: 2_250 }),
      }))
    })
  })

  it("creditAgreement refuses a record with no verifiable credit-life election", async () => {
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({
      id: "p1", interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.1, initiationFeeMax: 0, monthlyServiceFee: 6900,
    } as never)
    vi.mocked(generateCreditAgreementPdf).mockClear()
    const legacy = {
      productId: "p1", appliedAmount: 500000, appliedTermDays: 30, initiationFeePayment: "DEFERRED",
      reference: "APP-0003", agreementType: null,
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      pasqDocumentSha256: "d".repeat(64), pasqAcknowledgedSha256: "d".repeat(64),
      pasqEvidence: { calculator: { startDate: "2026-07-28T09:55:00.000Z" } },
    }
    await expect(SYSTEM_GENERATORS.creditAgreement(ctx({ application: legacy as never })))
      .rejects.toThrow(/credit-life election/)
    expect(generateCreditAgreementPdf).not.toHaveBeenCalled()
  })

  it("creditAgreement refuses an offer whose quotation terms cannot be read", async () => {
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({
      id: "p1", interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.1, initiationFeeMax: 0, monthlyServiceFee: 6900,
    } as never)
    vi.mocked(generateCreditAgreementPdf).mockClear()
    pasqIntact.mockReturnValueOnce(false)
    const application = {
      productId: "p1", appliedAmount: 500000, appliedTermDays: 30, initiationFeePayment: "DEFERRED",
      reference: "APP-0004", agreementType: null,
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      pasqDocumentSha256: "d".repeat(64), pasqAcknowledgedSha256: "d".repeat(64),
      pasqEvidence: { calculator: { startDate: "2026-07-28T09:55:00.000Z" } },
      ...declinedOffer(500000, 30),
    }
    await expect(SYSTEM_GENERATORS.creditAgreement(ctx({ application: application as never })))
      .rejects.toThrow(/quotation's credit-life terms/)
    expect(generateCreditAgreementPdf).not.toHaveBeenCalled()
  })

  it("creditAgreement rejects when the context has no application", async () => {
    await expect(SYSTEM_GENERATORS.creditAgreement(ctx())).rejects.toThrow(/requires an application/)
  })

  it("debitMandate calls the mocked generator and returns its Buffer", async () => {
    const evidence = createDebitMandateTestEvidence()
    vi.mocked(prisma.repaymentSchedule.findMany).mockResolvedValue(evidence.schedule as never)
    vi.mocked(prisma.loanApplication.findUnique).mockResolvedValue({
      initiationFeePayment: evidence.initiationFeePayment,
      affordabilityResult: evidence.affordabilityResult,
    } as never)
    const pdf = Buffer.from("debit-mandate")
    vi.mocked(generateDebitMandatePdf).mockResolvedValue(pdf)

    const loan = {
      id: "l1",
      applicationId: "app-1",
      principal: evidence.calculation.principal,
      totalInterest: evidence.calculation.totalInterest,
      initiationFee: evidence.calculation.initiationFee,
      totalRepayable: evidence.calculation.totalRepayable,
      reference: "LN-0001",
      startDate: evidence.startDate,
      maturityDate: evidence.maturityDate,
    }
    const result = await SYSTEM_GENERATORS.debitMandate(ctx({ loan: loan as never }))

    expect(generateDebitMandatePdf).toHaveBeenCalledTimes(1)
    expect(generateDebitMandatePdf).toHaveBeenCalledWith(
      expect.objectContaining({
        lender: expect.objectContaining({
          legalName: "Acme Lending (Pty) Ltd",
          ncrNumber: "NCRCP99999",
          registeredOfficeLines: ["1 Main Road", "Sandton", "2196"],
        }),
        creditorBank: {
          bankName: "Provider Bank",
          accountNumber: "9999999999",
          branchCode: "250655",
        },
        client: expect.objectContaining({
          firstName: "Thabo",
          lastName: "M",
          idNumber: "9001015800081",
          bankName: "Test Bank",
          branchCode: "000001",
          accountNumber: "1234567890",
          accountType: "CHEQUE",
        }),
        loan: expect.objectContaining({
          reference: "LN-0001",
          paymentFrequency: "MONTHLY",
          recurringDebitAmount: evidence.calculation.schedule[1].totalDue,
          firstDebitAmount: evidence.calculation.schedule[0].totalDue,
          firstDebitInitiationFee: evidence.calculation.initiationFee,
          firstDebitDate: evidence.calculation.schedule[0].dueDate,
        }),
      })
    )
    expect(result).toBe(pdf)
  })

  it("debitMandate rejects when the context has no loan", async () => {
    await expect(SYSTEM_GENERATORS.debitMandate(ctx())).rejects.toThrow(/requires a loan/)
  })

  it("section129 returns the immutable artifact from the successful issuance", async () => {
    const pdf = Buffer.from("section-129")
    vi.mocked(loadIssuedSection129Artifact).mockResolvedValue({
      pdf,
      issuanceId: "issuance-1",
      pdfSha256: "a".repeat(64),
      fileName: "Section-129-Notice-LN-0001.pdf",
    })

    const loan = {
      id: "loan-1",
      status: "DEFAULTED",
      reference: "LN-0001",
      arrearsAmount: 1000,
      outstandingPrincipal: 400000,
      daysInArrears: 90,
    }
    const result = await SYSTEM_GENERATORS.section129(ctx({ loan: loan as never }))

    expect(loadIssuedSection129Artifact).toHaveBeenCalledWith({
      tenantId: "t1",
      loanId: "loan-1",
    })
    expect(result).toBe(pdf)
  })

  it("section129 keeps a valid historical artifact retrievable after settlement", async () => {
    const pdf = Buffer.from("historical-section-129")
    vi.mocked(loadIssuedSection129Artifact).mockResolvedValue({
      pdf,
      issuanceId: "issuance-settled",
      pdfSha256: "b".repeat(64),
      fileName: "Section-129-Notice-LN-SETTLED.pdf",
    })

    const result = await SYSTEM_GENERATORS.section129(ctx({
      loan: {
        id: "loan-settled",
        status: "COMPLETED",
        reference: "LN-SETTLED",
        arrearsAmount: 0,
        outstandingPrincipal: 0,
        daysInArrears: 0,
      } as never,
    }))

    expect(result).toBe(pdf)
    expect(loadIssuedSection129Artifact).toHaveBeenCalledWith({ tenantId: "t1", loanId: "loan-settled" })
  })

  // a statutory document is refused, never defaulted, without a
  // configured lender identity.
  it("certificateOfBalance refuses and renders nothing when the lender identity is not configured", async () => {
    const { LenderIdentityError } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    lenderIdentityMocks.get.mockRejectedValueOnce(new LenderIdentityError(["ncrNumber"]))
    vi.mocked(generateCertificateOfBalancePdf).mockClear()
    const loan = {
      reference: "LN-0001", startDate: new Date("2026-01-01"), maturityDate: new Date("2026-07-01"),
      principal: 500000, totalRepayable: 550000, totalPaid: 100000, outstandingPrincipal: 450000,
      arrearsAmount: 0, daysInArrears: 0, interestRatePm: 0.05, lastPaymentDate: null, lastPaymentAmount: null,
    }
    await expect(SYSTEM_GENERATORS.certificateOfBalance(ctx({ loan: loan as never }))).rejects.toBeInstanceOf(LenderIdentityError)
    expect(generateCertificateOfBalancePdf).not.toHaveBeenCalled()
  })

  it("certificateOfBalance calls the mocked generator and returns its Buffer", async () => {
    const pdf = Buffer.from("cert-of-balance")
    vi.mocked(generateCertificateOfBalancePdf).mockResolvedValue(pdf)

    const loan = {
      reference: "LN-0001",
      startDate: new Date("2026-01-01"),
      maturityDate: new Date("2026-07-01"),
      principal: 500000,
      totalRepayable: 550000,
      totalPaid: 100000,
      outstandingPrincipal: 450000,
      arrearsAmount: 0,
      daysInArrears: 0,
      interestRatePm: 0.05,
      lastPaymentDate: null,
      lastPaymentAmount: null,
    }
    const result = await SYSTEM_GENERATORS.certificateOfBalance(ctx({ loan: loan as never }))

    expect(generateCertificateOfBalancePdf).toHaveBeenCalledTimes(1)
    // Charges off: no settlement block, so the certificate renders as on main.
    expect(vi.mocked(generateCertificateOfBalancePdf).mock.calls[0][0].settlement).toBeUndefined()
    expect(generateCertificateOfBalancePdf).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          firstName: "Thabo",
          lastName: "M",
          idNumber: "9001015800081",
        }),
        loan: expect.objectContaining({
          reference: "LN-0001",
          // Certificate-of-balance figures — cents, unconverted, must not swap.
          principal: 500000,
          totalRepayable: 550000,
          outstandingPrincipal: 450000,
        }),
      })
    )
    expect(result).toBe(pdf)
  })

  it("statement calls the mocked generator and returns its Buffer", async () => {
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({ name: "Personal Loan" } as never)
    vi.mocked(prisma.repaymentSchedule.findMany).mockResolvedValue([] as never)
    const receipt = {
      createdAt: new Date("2026-02-01"), receivedAt: new Date("2026-02-01"), amount: 100000,
      paymentMethod: "EFT", reference: "R1", reversed: false, reversedAt: null, reversalReason: null,
      allocationStatus: "ALLOCATED", reconciliationReason: null,
      defaultInterestAllocated: 1200, chargeFeesAllocated: 8200,
    }
    vi.mocked(prisma.payment.findMany).mockResolvedValue([receipt] as never)
    const pdf = Buffer.from("statement")
    vi.mocked(generateStatementPdf).mockResolvedValue(pdf)

    const loan = {
      id: "l1",
      productId: "p1",
      reference: "LN-0001",
      principal: 500000,
      totalRepayable: 550000,
      totalPaid: 100000,
      outstandingPrincipal: 450000,
      interestRatePm: 0.05,
      interestModel: "FLAT",
      status: "ACTIVE",
      startDate: new Date("2026-01-01"),
      maturityDate: new Date("2026-07-01"),
      daysInArrears: 0,
      arrearsAmount: 0,
    }
    const result = await SYSTEM_GENERATORS.statement(ctx({ loan: loan as never }))

    expect(generateStatementPdf).toHaveBeenCalledTimes(1)
    expect(generateStatementPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          firstName: "Thabo",
          lastName: "M",
          idNumber: "9001015800081",
        }),
        loan: expect.objectContaining({
          reference: "LN-0001",
          // Statement balances — cents, unconverted, and must not swap.
          principal: 500000,
          totalRepayable: 550000,
          outstandingPrincipal: 450000,
        }),
        // the receipt's default-charge split reaches the statement.
        payments: [expect.objectContaining({ amount: 100000, defaultInterestAllocated: 1200, chargeFeesAllocated: 8200 })],
      })
    )
    expect(result).toBe(pdf)
  })

  it("statement of a reversed (CANCELLED) loan states its cancelled instalments with nothing due", async () => {
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({ name: "Personal Loan" } as never)
    vi.mocked(prisma.repaymentSchedule.findMany).mockResolvedValue([
      { installmentNo: 1, dueDate: new Date("2026-11-04"), totalDue: 1_256_986, totalPaid: 0, status: "CANCELLED" },
    ] as never)
    vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never)
    vi.mocked(generateStatementPdf).mockResolvedValue(Buffer.from("statement"))
    const loan = {
      id: "l1", productId: "p1", reference: "LN-REV-1", principal: 1_000_000, totalRepayable: 1_256_986, totalPaid: 0,
      outstandingPrincipal: 0, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", status: "CANCELLED",
      startDate: new Date("2026-10-04"), maturityDate: new Date("2027-04-04"), daysInArrears: 0, arrearsAmount: 0,
    }
    await SYSTEM_GENERATORS.statement(ctx({ loan: loan as never }))
    expect(generateStatementPdf).toHaveBeenCalledWith(expect.objectContaining({
      loan: expect.objectContaining({ totalRepayable: 0, outstandingPrincipal: 0 }),
      schedule: [expect.objectContaining({ installmentNo: 1, totalDue: 0, status: "CANCELLED" })],
    }))
  })

  it("faisDisclosure calls the mocked generator and returns its Buffer", async () => {
    vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue({
      type: "FUNERAL_COVER",
      insurer: "Legacy Insurer",
      insurer_rel: null,
      advisor: { name: "Agent Smith", email: "agent@example.com", faisRepresentativeNumber: "FSP-1" },
      product: { name: "Family Funeral Plan" },
      sumAssured: { toNumber: () => 50000 },
      premiumAmount: { toNumber: () => 150 },
    } as never)
    const pdf = Buffer.from("fais-disclosure")
    vi.mocked(generateFaisDisclosurePdf).mockResolvedValue(pdf)

    const result = await SYSTEM_GENERATORS.faisDisclosure(ctx())

    expect(generateFaisDisclosurePdf).toHaveBeenCalledTimes(1)
    expect(result).toBe(pdf)
  })

  it("faisDisclosure rejects when the client has no insurance policy", async () => {
    vi.mocked(prisma.insurancePolicy.findFirst).mockResolvedValue(null)
    await expect(SYSTEM_GENERATORS.faisDisclosure(ctx())).rejects.toThrow(/No insurance policy found/)
  })

  it("preAgreement rejects with SystemGeneratorUnavailableError", async () => {
    await expect(SYSTEM_GENERATORS.preAgreement(ctx())).rejects.toThrow(SystemGeneratorUnavailableError)
  })

  it("affordabilityAssessment rejects with SystemGeneratorUnavailableError", async () => {
    await expect(SYSTEM_GENERATORS.affordabilityAssessment(ctx())).rejects.toThrow(SystemGeneratorUnavailableError)
  })
})

describe("creditAgreement adapter — acknowledgement gate", () => {
  it("refuses to render a credit agreement without the recorded consumer acknowledgement", async () => {
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({
      id: "p1",
      interestRatePm: 0.05,
      interestModel: "FLAT",
      initiationFeePct: 0.1,
      initiationFeeMax: 0,
      monthlyServiceFee: 6900,
    } as never)
    const unacknowledged = {
      productId: "p1",
      appliedAmount: 500000,
      appliedTermDays: 30,
      initiationFeePayment: "DEFERRED",
      reference: "APP-0002",
      agreementType: null,
      pasqAcknowledgedAt: null,
      pasqDocumentSha256: "d".repeat(64),
      pasqAcknowledgedSha256: null,
      pasqEvidence: { calculator: { startDate: "2026-07-28T09:55:00.000Z" } },
    }
    await expect(
      SYSTEM_GENERATORS.creditAgreement(ctx({ application: unacknowledged as never })),
    ).rejects.toThrow(/acknowledged the current Pre-Agreement/)
    expect(generateCreditAgreementPdf).not.toHaveBeenCalled()
  })

  it("refuses when the acknowledged digest does not match the current quotation", async () => {
    // Own product mock: clearAllMocks preserves implementations, so without
    // this the test only reaches the digest gate when run after its sibling.
    vi.mocked(prisma.loanProduct.findUnique).mockResolvedValue({
      id: "p1",
      interestRatePm: 0.05,
      interestModel: "FLAT",
      initiationFeePct: 0.1,
      initiationFeeMax: 0,
      monthlyServiceFee: 6900,
    } as never)
    const stale = {
      productId: "p1",
      appliedAmount: 500000,
      appliedTermDays: 30,
      initiationFeePayment: "DEFERRED",
      reference: "APP-0003",
      agreementType: null,
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00.000Z"),
      pasqDocumentSha256: "d".repeat(64),
      pasqAcknowledgedSha256: "e".repeat(64),
      pasqEvidence: { calculator: { startDate: "2026-07-28T09:55:00.000Z" } },
    }
    await expect(
      SYSTEM_GENERATORS.creditAgreement(ctx({ application: stale as never })),
    ).rejects.toThrow(/acknowledged the current Pre-Agreement/)
    expect(generateCreditAgreementPdf).not.toHaveBeenCalled()
  })
})
