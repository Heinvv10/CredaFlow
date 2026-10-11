/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_PASQ_V3_BILLING_IT=1 DATABASE_URL=postgresql://... \
 *     pnpm vitest run lib/compliance/pasq-v3-billing-migration.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import {
  bookLoan,
  createApprovedPasqV3Application,
  signedMandateReturnToReviewData,
} from "@/lib/compliance/pasq-v3-application.integration-fixture"
import { readAffordabilitySnapshotStore } from "@/lib/affordability/snapshot"
import {
  debitMandateEvidenceSha256,
  readDebitMandateEvidence,
  type DebitMandateEvidence,
} from "@/lib/compliance/debit-mandate"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { runWithTenant } from "@/lib/tenant-scope"

const suite = process.env.RUN_PASQ_V3_BILLING_IT === "1"
  ? describe
  : describe.skip

const alteredMandateTerms: Array<[
  string,
  (evidence: DebitMandateEvidence) => DebitMandateEvidence,
]> = [
  [
    "contract fingerprint",
    (evidence) => ({
      ...evidence,
      contractFingerprint: "0".repeat(64),
    }),
  ],
  [
    "first debit amount",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        firstDebitAmountCents: evidence.terms.firstDebitAmountCents + 1,
      },
    }),
  ],
  [
    "payment frequency",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        paymentFrequency: "MONTHLY",
        recurringDebitAmountCents: 1,
      },
    }),
  ],
  [
    "first debit date",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        firstDebitDate: new Date(
          new Date(evidence.terms.firstDebitDate).getTime() + 86_400_000,
        ).toISOString(),
      },
    }),
  ],
  [
    "first-debit initiation fee",
    (evidence) => ({
      ...evidence,
      terms: {
        ...evidence.terms,
        firstDebitInitiationFeeCents:
          evidence.terms.firstDebitInitiationFeeCents + 1,
      },
    }),
  ],
]

suite("PASQ v3 billing and branch-witness database authority", () => {
  it("accepts only a loan and schedule that reproduce the acknowledged billing evidence", async () => {
    const scenario = await createApprovedPasqV3Application("valid")
    const loanId = await bookLoan(scenario)
    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true },
    })
    expect(loan.totalRepayable).toBe(
      scenario.pasqEvidence.billing.totalRepayableCents,
    )
    expect(loan.creditLifePremiums).toBe(
      scenario.pasqEvidence.creditLife.totalPremiumCents,
    )
    expect(loan.repaymentSchedule[0].creditLifePremiumDue).toBe(2_250)
  })

  it("accepts an audited, ledger-balanced early DAILY_ACCRUAL settlement rebate", async () => {
    const scenario = await createApprovedPasqV3Application(
      "early-settlement",
    )
    const loanId = await bookLoan(scenario)
    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true },
    })
    const contractualInterest =
      scenario.pasqEvidence.calculator.totalInterestCents
    const contractualTotal =
      scenario.pasqEvidence.billing.totalRepayableCents
    const resultingInterest = contractualInterest - 1
    const resultingTotal = contractualTotal - 1
    const closedAt = new Date("2026-07-27T09:00:00.000Z")

    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId: scenario.tenantId,
          loanId,
          amount: resultingTotal,
          paymentMethod: "EFT",
          reference: "PASQ-V3-EARLY-SETTLEMENT",
          capturedBy: scenario.officerId,
        },
      })
      await tx.repaymentSchedule.update({
        where: {
          id: loan.repaymentSchedule[0].id,
          tenantId: scenario.tenantId,
        },
        data: {
          interestDue: resultingInterest,
          totalDue: resultingTotal,
          totalPaid: resultingTotal,
          status: "PAID",
          paidAt: closedAt,
        },
      })
      await tx.loan.update({
        where: { id: loanId, tenantId: scenario.tenantId },
        data: {
          totalInterest: resultingInterest,
          totalRepayable: resultingTotal,
          contractualTotalInterest: contractualInterest,
          contractualTotalRepayable: contractualTotal,
          totalPaid: resultingTotal,
          outstandingPrincipal: 0,
          status: "COMPLETED",
          closedAt,
          nextPaymentDate: null,
          arrearsAmount: 0,
          daysInArrears: 0,
        },
      })
      await tx.auditLog.create({
        data: {
          tenantId: scenario.tenantId,
          userId: scenario.officerId,
          action: "PAYMENT_RECORDED",
          entity: "Loan",
          entityId: loanId,
          newValue: {
            paymentId: payment.id,
            settlementDue: resultingTotal,
            earlyDailySettlement: true,
            accruedInterest: resultingInterest,
            interestRebate: 1,
            resultingTotalInterest: resultingInterest,
            resultingTotalRepayable: resultingTotal,
            contractualTotalInterest: contractualInterest,
            contractualTotalRepayable: contractualTotal,
          },
        },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })

    const settled = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true, payments: true },
    })
    expect(settled).toMatchObject({
      status: "COMPLETED",
      totalInterest: resultingInterest,
      totalRepayable: resultingTotal,
      contractualTotalInterest: contractualInterest,
      contractualTotalRepayable: contractualTotal,
      totalPaid: resultingTotal,
      outstandingPrincipal: 0,
    })
    expect(settled.repaymentSchedule).toEqual([
      expect.objectContaining({
        interestDue: resultingInterest,
        totalDue: resultingTotal,
        totalPaid: resultingTotal,
        status: "PAID",
      }),
    ])
    expect(settled.payments).toEqual([
      expect.objectContaining({ amount: resultingTotal }),
    ])
  })

  it("rejects a DAILY_ACCRUAL rebate without matching atomic audit evidence", async () => {
    const scenario = await createApprovedPasqV3Application(
      "unaudited-early-settlement",
    )
    const loanId = await bookLoan(scenario)
    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
      include: { repaymentSchedule: true },
    })
    const contractualInterest =
      scenario.pasqEvidence.calculator.totalInterestCents
    const contractualTotal =
      scenario.pasqEvidence.billing.totalRepayableCents
    const resultingInterest = contractualInterest - 1
    const resultingTotal = contractualTotal - 1
    const closedAt = new Date("2026-07-27T09:00:00.000Z")

    await expect(prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          tenantId: scenario.tenantId,
          loanId,
          amount: resultingTotal,
          paymentMethod: "EFT",
          reference: "PASQ-V3-UNAUTHORISED-REBATE",
          capturedBy: scenario.officerId,
        },
      })
      await tx.repaymentSchedule.update({
        where: {
          id: loan.repaymentSchedule[0].id,
          tenantId: scenario.tenantId,
        },
        data: {
          interestDue: resultingInterest,
          totalDue: resultingTotal,
          totalPaid: resultingTotal,
          status: "PAID",
          paidAt: closedAt,
        },
      })
      await tx.loan.update({
        where: { id: loanId, tenantId: scenario.tenantId },
        data: {
          totalInterest: resultingInterest,
          totalRepayable: resultingTotal,
          totalPaid: resultingTotal,
          outstandingPrincipal: 0,
          status: "COMPLETED",
          closedAt,
        },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow(
      /Early DAILY_ACCRUAL settlement does not preserve PASQ v3 contractual and ledger evidence/i,
    )

    await expect(prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
    })).resolves.toMatchObject({ status: "ACTIVE", totalPaid: 0 })
    await expect(prisma.payment.count({
      where: { loanId, tenantId: scenario.tenantId },
    })).resolves.toBe(0)
  })

  // main covered the ZERO-offset case: an agreement generated at the quote
  // instant, whose ledger dates reproduce the signed agreement exactly. The
  // shifted-offset case below is a different scenario, not a replacement, so
  // both are kept — dropping this one would stop testing offset == 0.
  it("accepts ledger dates that exactly reproduce the signed agreement", async () => {
    const scenario = await createApprovedPasqV3Application("valid-rebase")
    await expect(bookLoan(scenario)).resolves.toEqual(expect.any(String))
  })

  it("accepts a non-zero agreement rebase with exactly shifted ledger dates", async () => {
    const scenario = await createApprovedPasqV3Application(
      "valid-rebase",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-27T08:00:00.000Z"),
      },
    )
    await expect(bookLoan(scenario)).resolves.toEqual(expect.any(String))
  })

  it("rejects agreement generation before the acknowledged quote", async () => {
    await expect(createApprovedPasqV3Application(
      "agreement-before-quote",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-24T07:59:59.999Z"),
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects agreement generation after the binding quote window", async () => {
    await expect(createApprovedPasqV3Application(
      "agreement-after-window",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-08-01T08:00:00.000Z"),
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects a contract that extends the computed quote-valid date", async () => {
    await expect(createApprovedPasqV3Application(
      "altered-quote-valid-date",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-27T08:00:00.000Z"),
        quoteValidUntilDate: "2026-08-31",
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects a contract schedule not shifted by the exact agreement offset", async () => {
    await expect(createApprovedPasqV3Application(
      "altered-rebase-offset",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {
        agreementGeneratedAt:
          new Date("2026-07-27T08:00:00.000Z"),
        firstDueDateOffsetMs: 1,
      },
    )).rejects.toThrow(
      /active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects payout on a later SAST date than the signed agreement", async () => {
    const scenario = await createApprovedPasqV3Application("expired-rebase")
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-25T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedLater)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  // The case above books with repaymentMethod NULL, which takes the strict
  // path. These cover the EFT relaxation in the trigger
  // — the ONLY method for which payout may lag the signature.
  // A mocked Prisma cannot execute this trigger, so this is the only place the
  // scoping is actually proved.
  it("accepts an EFT payout lagging the signature when the schedule shifts with it", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-lagged-payout",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-27T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedLater, 0, 3)).resolves.toEqual(
      expect.any(String),
    )
  })

  it("rejects an EFT payout lag the booked schedule does not carry", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-unshifted-schedule",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-27T08:08:00.000Z"),
    }
    // Relaxing the same-day rule must not relax the arithmetic: the term is
    // held at its disclosed length by shifting every due date by the payout
    // lag. Leaving the dates on the agreement offset shortens the term, which
    // is the rate-cap breach the change exists to prevent.
    await expect(bookLoan(fundedLater, 0, 0)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  it("rejects an EFT payout beyond the binding quote window", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-payout-after-window",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedTooLate = {
      ...scenario,
      signedAt: new Date("2026-08-01T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedTooLate, 0, 8)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  // The paired accept case for the bound above. Without it the guard could use
  // `>=` and still pass every other test here, silently costing the consumer
  // the last lawful day of a window s92(3) grants them. 2026-07-31 IS the
  // valid-until date for this fixture's quote, not the day after it.
  it("accepts an EFT payout on the last day of the quote window", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-payout-on-window-boundary",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedOnBoundary = {
      ...scenario,
      signedAt: new Date("2026-07-31T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedOnBoundary, 0, 7)).resolves.toEqual(
      expect.any(String),
    )
  })

  it("rejects an EFT payout dated before the agreement", async () => {
    const scenario = await createApprovedPasqV3Application(
      "eft-payout-before-agreement",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "EFT",
    )
    const fundedEarlier = {
      ...scenario,
      signedAt: new Date("2026-07-23T08:08:00.000Z"),
    }
    await expect(bookLoan(fundedEarlier, 0, -1)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  it("keeps the same-day rule for an explicit DEBIT_ORDER", async () => {
    const scenario = await createApprovedPasqV3Application(
      "debit-order-lagged-payout",
      "ACCEPTED",
      true,
      "DEFERRED",
      false,
      null,
      {},
      "DEBIT_ORDER",
    )
    const fundedLater = {
      ...scenario,
      signedAt: new Date("2026-07-27T08:08:00.000Z"),
    }
    // A signed mandate fixes the debit dates before payout, so a lagged payout
    // has no lawful schedule to book against — with or without the shift.
    await expect(bookLoan(fundedLater, 0, 3)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
    await expect(bookLoan(fundedLater, 0, 0)).rejects.toThrow(
      /quote window and signed agreement/i,
    )
  })

  it("counts a configured proclaimed holiday in the quote window", async () => {
    const rows = await prisma.$queryRaw<Array<{ validUntilDate: string }>>`
      SELECT TO_CHAR(
        "quoteValidUntilDate"(
          TIMESTAMPTZ '2024-05-22T08:00:00.000Z'
        ),
        'YYYY-MM-DD'
      ) AS "validUntilDate"
    `
    expect(rows).toEqual([{ validUntilDate: "2024-05-30" }])
  })

  it("observes Monday when a configured proclaimed holiday falls on Sunday", async () => {
    const sunday = new Date("2026-07-26T00:00:00.000Z")
    await prisma.saProclaimedPublicHoliday.upsert({
      where: { date: sunday },
      create: {
        date: sunday,
        name: "Synthetic Sunday proclamation",
        sourceUrl: "https://example.invalid/synthetic-test-proclamation",
      },
      update: {},
    })
    try {
      const rows = await prisma.$queryRaw<Array<{ validUntilDate: string }>>`
        SELECT TO_CHAR(
          "quoteValidUntilDate"(
            TIMESTAMPTZ '2026-07-21T08:00:00.000Z'
          ),
          'YYYY-MM-DD'
        ) AS "validUntilDate"
      `
      expect(rows).toEqual([{ validUntilDate: "2026-07-29" }])
    } finally {
      await prisma.saProclaimedPublicHoliday.delete({
        where: { date: sunday },
      })
    }
  })

  it("rejects a loan total that excludes part of the accepted premium", async () => {
    const scenario = await createApprovedPasqV3Application("wrong-total")
    await expect(bookLoan(scenario, -1)).rejects.toThrow(
      /acknowledged PASQ v3 billing evidence/i,
    )
  })

  it("rejects later mutation of every protected repayment amount", async () => {
    const scenario = await createApprovedPasqV3Application("mutated-schedule")
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { principalDue: row.principalDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { interestDue: row.interestDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { creditLifePremiumDue: row.creditLifePremiumDue - 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { feesDue: row.feesDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { totalDue: row.totalDue + 1 },
    })).rejects.toThrow(/repayment schedule does not match/i)
  })

  it("rejects moving a booked repayment to another disclosed SAST date", async () => {
    const scenario = await createApprovedPasqV3Application("mutated-date")
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { dueDate: new Date(row.dueDate.getTime() + 86_400_000) },
    })).rejects.toThrow(/schedule dates do not match/i)
  })

  it.each(alteredMandateTerms)(
    "rejects a signed mandate with an altered %s",
    async (label, alter) => {
      const scenario = await createApprovedPasqV3Application(
        `altered-mandate-${label.replaceAll(" ", "-")}`,
      )
      const stored = await prisma.loanApplication.findUniqueOrThrow({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        select: { debitMandateEvidence: true },
      })
      const evidence = readDebitMandateEvidence(
        stored.debitMandateEvidence,
      )
      expect(evidence).not.toBeNull()
      const altered = alter(evidence!)
      await expect(prisma.loanApplication.update({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        data: {
          debitMandateEvidence:
            altered as unknown as Prisma.InputJsonValue,
          debitMandateEvidenceSha256:
            debitMandateEvidenceSha256(altered),
        },
      })).rejects.toThrow(/terms bound to the signed contract|immutable/i)
    },
  )

  it("rejects a coherent replacement of signed mandate and contract fingerprints before payout", async () => {
    const scenario = await createApprovedPasqV3Application(
      "coherent-mandate-replacement",
    )
    const stored = await prisma.loanApplication.findUniqueOrThrow({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      select: {
        affordabilityResult: true,
        debitMandateEvidence: true,
      },
    })
    const evidence = readDebitMandateEvidence(stored.debitMandateEvidence)
    expect(evidence).not.toBeNull()
    const replacementFingerprint = "0".repeat(64)
    const alteredEvidence = {
      ...evidence!,
      contractFingerprint: replacementFingerprint,
    }
    const alteredAffordability = structuredClone(
      stored.affordabilityResult,
    ) as {
      contract: {
        fingerprint: string
      }
    }
    alteredAffordability.contract.fingerprint = replacementFingerprint

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        affordabilityResult:
          alteredAffordability as unknown as Prisma.InputJsonValue,
        debitMandateEvidence:
          alteredEvidence as unknown as Prisma.InputJsonValue,
        debitMandateEvidenceSha256:
          debitMandateEvidenceSha256(alteredEvidence),
      },
    })).rejects.toThrow(
      /signed debit-mandate authority is immutable|archived contract evidence must exactly record|active contract evidence requires validated agreement generation/i,
    )
  })

  it("rejects an operational initiation-fee election that differs from the signed approval", async () => {
    await expect(createApprovedPasqV3Application(
      "initiation-fee-election-mismatch",
      "ACCEPTED",
      true,
      "UPFRONT",
    )).rejects.toThrow(
      /terms bound to the signed contract|active approval evidence requires a validated approval transition/i,
    )
  })

  it.each([
    ["approval decision", "approval_hash"],
    ["contract envelope", "contract_hash"],
  ] as const)(
    "cryptographically rejects a forged %s hash during its otherwise valid lifecycle transition",
    async (_label, tamperFinalEvidence) => {
      await expect(createApprovedPasqV3Application(
        `forged-${tamperFinalEvidence}`,
        "ACCEPTED",
        true,
        "DEFERRED",
        false,
        tamperFinalEvidence,
      )).rejects.toThrow(
        /active (approval|contract) evidence requires/i,
      )
    },
  )

  it("allows evidence-free inserts and rejects staged active or archived evidence fabrication", async () => {
    const scenario = await createApprovedPasqV3Application(
      "decision-history-insert",
      "DECLINED",
      false,
    )
    const createApplication = (
      label: string,
      affordabilityResult: Prisma.InputJsonValue,
    ) => {
      const token = randomUUID().replaceAll("-", "")
      return prisma.loanApplication.create({
        data: {
          id: `application_history_insert_${label}_${token}`,
          tenantId: scenario.tenantId,
          reference: `APP-HISTORY-INSERT-${label}-${token}`,
          clientId: scenario.clientId,
          productId: scenario.productId,
          appliedAmount: scenario.calculation.principal,
          appliedTermDays: 30,
          status: "DECLINED",
          affordabilityResult,
        },
      })
    }

    const historyFreeApplication = await createApplication(
      "history-free",
      {
        schemaVersion: 3,
        submissionMarker: "normal-insert",
      },
    )
    expect(historyFreeApplication).toMatchObject({
      status: "DECLINED",
      affordabilityResult: {
        submissionMarker: "normal-insert",
      },
    })

    const forbiddenHistoryValues: Array<{
      label: string
      value: unknown
    }> = [
      { label: "empty-array", value: [] },
      { label: "json-null", value: null },
      { label: "scalar", value: "fabricated" },
      { label: "object", value: { fabricated: true } },
      { label: "populated-array", value: [{ fabricated: true }] },
    ]

    for (const evidenceKey of [
      "approval",
      "contract",
      "approvalHistory",
      "contractHistory",
    ] as const) {
      for (const forbidden of forbiddenHistoryValues) {
        await expect(createApplication(
          `${evidenceKey}-${forbidden.label}`,
          {
            schemaVersion: 3,
            [evidenceKey]: forbidden.value,
          } as unknown as Prisma.InputJsonValue,
        )).rejects.toThrow(
          /active and archived decision evidence require a validated lifecycle transition/i,
        )
      }
    }

    for (const evidenceKey of ["approval", "contract"] as const) {
      await expect(prisma.loanApplication.update({
        where: {
          id: historyFreeApplication.id,
          tenantId: scenario.tenantId,
        },
        data: {
          affordabilityResult: {
            schemaVersion: 3,
            submissionMarker: "normal-insert",
            [evidenceKey]: {
              fabricated: true,
            },
          },
        },
      })).rejects.toThrow(
        new RegExp(
          `active ${evidenceKey} evidence requires`,
          "i",
        ),
      )
    }
  })

  it("permits only a complete return-to-review reset and retains the signed mandate artifact immutably", async () => {
    const scenario = await createApprovedPasqV3Application(
      "mandate-return-to-review",
      "ACCEPTED",
      true,
      "DEFERRED",
      true,
    )
    const before = await prisma.loanApplication.findUniqueOrThrow({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      select: {
        affordabilityResult: true,
        bureauReviewGeneration: true,
        debitMandateDocumentId: true,
      },
    })
    expect(before.debitMandateDocumentId).not.toBeNull()

    const resetData = signedMandateReturnToReviewData({
      officerId: scenario.officerId,
      affordabilityResult: before.affordabilityResult,
    })
    const signedAuthorityOrHistoryGuard =
      /signed debit-mandate authority is immutable|archived (approval|contract) evidence/i

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        affordabilityResult: {} as Prisma.InputJsonValue,
      },
    })).rejects.toThrow(signedAuthorityOrHistoryGuard)

    const truncatedAffordability = structuredClone(
      resetData.affordabilityResult,
    ) as Record<string, unknown>
    delete truncatedAffordability.preservedReviewMarker
    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        affordabilityResult:
          truncatedAffordability as Prisma.InputJsonValue,
      },
    })).rejects.toThrow(signedAuthorityOrHistoryGuard)

    const supersetAffordability = structuredClone(
      resetData.affordabilityResult,
    ) as {
      approvalHistory: unknown[]
    }
    supersetAffordability.approvalHistory.push({
      injected: "not-route-history",
    })
    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        affordabilityResult:
          supersetAffordability as unknown as Prisma.InputJsonValue,
      },
    })).rejects.toThrow(signedAuthorityOrHistoryGuard)

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: {
        ...resetData,
        appliedAmount: scenario.calculation.principal + 1,
      },
    })).rejects.toThrow(/signed debit-mandate authority is immutable/i)

    await expect(prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: resetData,
      select: {
        status: true,
        affordabilityResult: true,
        bureauReviewGeneration: true,
        debitMandateDocumentId: true,
      },
    })).resolves.toMatchObject({
      status: "UNDER_REVIEW",
      debitMandateDocumentId: null,
    })

    const returned = await prisma.loanApplication.findUniqueOrThrow({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      select: {
        affordabilityResult: true,
        bureauReviewGeneration: true,
      },
    })
    const returnedAffordability = readAffordabilitySnapshotStore(
      returned.affordabilityResult,
    )
    expect(returnedAffordability.approval).toBeUndefined()
    expect(returnedAffordability.contract).toBeUndefined()
    expect(returnedAffordability.approvalHistory).toHaveLength(2)
    expect(returnedAffordability.contractHistory).toHaveLength(2)
    expect(returned.affordabilityResult).toMatchObject({
      preservedReviewMarker: {
        cycle: "prior-review",
        retained: true,
      },
    })
    expect(returned.bureauReviewGeneration).not.toBe(
      before.bureauReviewGeneration,
    )

    const postResetAffordability = structuredClone(
      returned.affordabilityResult,
    ) as {
      approvalHistory: unknown[]
      contractHistory: unknown[]
    }
    const destructiveHistoryUpdates: Array<{
      label: string
      affordabilityResult: Prisma.InputJsonValue
    }> = [
      {
        label: "delete all archived evidence",
        affordabilityResult: {},
      },
      {
        label: "truncate approval history",
        affordabilityResult: {
          ...postResetAffordability,
          approvalHistory: postResetAffordability.approvalHistory.slice(1),
        } as Prisma.InputJsonValue,
      },
      {
        label: "replace an approval history entry",
        affordabilityResult: {
          ...postResetAffordability,
          approvalHistory: [
            { replaced: true },
            ...postResetAffordability.approvalHistory.slice(1),
          ],
        } as Prisma.InputJsonValue,
      },
      {
        label: "reorder contract history",
        affordabilityResult: {
          ...postResetAffordability,
          contractHistory:
            [...postResetAffordability.contractHistory].reverse(),
        } as Prisma.InputJsonValue,
      },
      {
        label: "mutate a contract history entry",
        affordabilityResult: {
          ...postResetAffordability,
          contractHistory: [
            ...postResetAffordability.contractHistory.slice(0, -1),
            { mutated: true },
          ],
        } as Prisma.InputJsonValue,
      },
      {
        label: "append fabricated approval history",
        affordabilityResult: {
          ...postResetAffordability,
          approvalHistory: [
            ...postResetAffordability.approvalHistory,
            { fabricated: true },
          ],
        } as Prisma.InputJsonValue,
      },
      {
        label: "append fabricated contract history",
        affordabilityResult: {
          ...postResetAffordability,
          contractHistory: [
            ...postResetAffordability.contractHistory,
            { fabricated: true },
          ],
        } as Prisma.InputJsonValue,
      },
    ]

    for (const destructiveUpdate of destructiveHistoryUpdates) {
      await expect(prisma.loanApplication.update({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        data: {
          affordabilityResult: destructiveUpdate.affordabilityResult,
        },
      }), destructiveUpdate.label).rejects.toThrow(
        /archived (approval|contract) evidence/i,
      )
    }

    await expect(prisma.clientDocument.update({
      where: {
        id: before.debitMandateDocumentId!,
        tenantId: scenario.tenantId,
      },
      data: { fileName: "rewritten-signed-mandate.pdf" },
    })).rejects.toThrow(/signed debit-mandate documents are immutable/i)
  })

  it("does not revalidate legacy PASQ evidence for payment-progress projections", async () => {
    const scenario = await createApprovedPasqV3Application("legacy-progress")
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      )
      await tx.repaymentSchedule.update({
        where: { id: row.id, tenantId: scenario.tenantId },
        data: { totalDue: row.totalDue + 1 },
      })
    })

    await expect(prisma.loan.update({
      where: { id: loanId, tenantId: scenario.tenantId },
      data: {
        lastPaymentAmount: 1,
        lastPaymentDate: new Date("2026-07-25T08:00:00.000Z"),
      },
    })).resolves.toMatchObject({ lastPaymentAmount: 1 })
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: {
        totalPaid: 1,
        paidAt: new Date("2026-07-25T08:00:00.000Z"),
        status: "PARTIAL",
      },
    })).resolves.toMatchObject({ totalPaid: 1, status: "PARTIAL" })

    const loan = await prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
    })
    await expect(prisma.loan.update({
      where: { id: loanId, tenantId: scenario.tenantId },
      data: { principal: loan.principal + 1 },
    })).rejects.toThrow(
      /acknowledged PASQ v3 billing evidence|frozen loan principal/i,
    )
    await expect(prisma.repaymentSchedule.update({
      where: { id: row.id, tenantId: scenario.tenantId },
      data: { dueDate: new Date(row.dueDate.getTime() + 86_400_000) },
    })).rejects.toThrow(/schedule dates do not match/i)
  })

  it("commits an ordinary receipt without initializing legacy-null contractual totals", async () => {
    const scenario = await createApprovedPasqV3Application(
      "legacy-null-contractual-progress",
    )
    const loanId = await bookLoan(scenario)
    const row = await prisma.repaymentSchedule.findFirstOrThrow({
      where: { loanId, tenantId: scenario.tenantId },
    })

    // Reproduce the deployed legacy shape: tolerated pre-existing schedule
    // drift plus NULL contractual totals from before the contractual-total
    // columns were enforced. The repair uses replica mode only to construct that
    // historical fixture; the receipt itself goes through the production
    // transaction path and all live guards.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      )
      await tx.repaymentSchedule.update({
        where: { id: row.id, tenantId: scenario.tenantId },
        data: { totalDue: row.totalDue + 1 },
      })
      await tx.loan.update({
        where: { id: loanId, tenantId: scenario.tenantId },
        data: {
          contractualTotalInterest: null,
          contractualTotalRepayable: null,
        },
      })
    })

    await expect(runWithTenant(
      scenario.tenantId,
      () => applyManualReceipt(prisma, {
        loanId,
        tenantId: scenario.tenantId,
        amount: 1,
        paymentMethod: "EFT",
        reference: "LEGACY-NULL-PARTIAL",
        capturedById: scenario.officerId,
        capturedByEmail: "legacy-null@example.test",
        idempotencyKey: `legacy-null-${randomUUID()}`,
      }),
    )).resolves.toMatchObject({
      idempotentReplay: false,
      payment: {
        loanId,
        amount: 1,
      },
    })

    await expect(prisma.loan.findUniqueOrThrow({
      where: { id: loanId, tenantId: scenario.tenantId },
    })).resolves.toMatchObject({
      totalPaid: 1,
      contractualTotalInterest: null,
      contractualTotalRepayable: null,
    })
    await expect(prisma.payment.count({
      where: { loanId, tenantId: scenario.tenantId },
    })).resolves.toBe(1)
  })

  it("requires an active authorised branch witness from the application tenant", async () => {
    const scenario = await createApprovedPasqV3Application(
      "branch-witness",
      "DECLINED",
      false,
    )
    const otherTenantId = `other_${randomUUID().replaceAll("-", "")}`
    const otherUserId = `other_user_${randomUUID().replaceAll("-", "")}`
    const readonlyUserId = `readonly_${randomUUID().replaceAll("-", "")}`
    const authorisedUserId = `authorised_${randomUUID().replaceAll("-", "")}`
    await prisma.tenant.create({
      data: {
        id: otherTenantId,
        slug: `other-${randomUUID()}`,
        name: "Other synthetic tenant",
      },
    })
    await prisma.user.createMany({
      data: [
        {
          id: otherUserId,
          tenantId: otherTenantId,
          email: `${otherUserId}@example.invalid`,
          password: "not-a-real-login",
          role: "LOAN_ADMIN",
        },
        {
          id: readonlyUserId,
          tenantId: scenario.tenantId,
          email: `${readonlyUserId}@example.invalid`,
          password: "not-a-real-login",
          role: "READONLY",
        },
        {
          id: authorisedUserId,
          tenantId: scenario.tenantId,
          email: `${authorisedUserId}@example.invalid`,
          password: "not-a-real-login",
          role: "CREDIT_OFFICER",
        },
      ],
    })
    const signedAt = new Date("2026-07-24T08:20:00.000Z")
    const signatureData = "data:image/png;base64,YnJhbmNoLXdpdG5lc3M="
    const signWith = (agreementSignedByUserId: string) =>
      prisma.loanApplication.update({
        where: {
          id: scenario.applicationId,
          tenantId: scenario.tenantId,
        },
        data: {
          agreementGeneratedAt: signedAt,
          agreementDocumentId: `agreement-${scenario.applicationId}`,
          agreementDocumentSha256: "b".repeat(64),
          agreementSignedAt: signedAt,
          agreementSignedMethod: "branch",
          agreementSignedByUserId,
          agreementSignatureData: signatureData,
        },
      })

    await expect(signWith(otherUserId)).rejects.toThrow()
    await expect(signWith(readonlyUserId)).rejects.toThrow(
      /active authorised witness/i,
    )
    const signed = await signWith(authorisedUserId)
    expect(signed.agreementSignedByUserId).toBe(authorisedUserId)

    // Authority is evaluated at the instant of signing. A later, legitimate
    // staff deactivation must preserve the historical witness evidence without
    // freezing unrelated lifecycle updates on the signed application.
    await prisma.user.update({
      where: { id: authorisedUserId, tenantId: scenario.tenantId },
      data: { active: false },
    })
    const progressed = await prisma.loanApplication.update({
      where: {
        id: scenario.applicationId,
        tenantId: scenario.tenantId,
      },
      data: { purpose: "Post-signing lifecycle progression" },
    })
    expect(progressed.purpose).toBe("Post-signing lifecycle progression")
  })
})
