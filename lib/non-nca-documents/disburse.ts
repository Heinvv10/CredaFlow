/**
 * Booking the loan of a KEY_FACTS application (a jurisdiction without the NCA): the payout side of A10b. The gates are in payout-gates.ts.
 * The loan and its schedule are booked exactly as the signed agreement printed them, the application becomes DISBURSED (the database
 * re-runs the document gate there), and the audit rows are written, all in the gates' transaction.
 *
 * THE PAYOUT IS MANUAL. No money is moved here: the officer makes the transfer at the bank and records its reference, and every row says
 * so (payoutChannel "MANUAL"). An automated rail is a payout provider adapter behind lib/payouts/registry.ts: for Lesotho PostBank that is
 * the core banking API of tender requirement 2.5.1 (docs/non-nca-go-live.md). Not built.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recordOriginationTerms } from "@/lib/disbursement/loan-terms"
import { unusedLoanReference } from "@/lib/loan/loan-reference"
import { triggerNotification } from "@/lib/notifications"
import { logger } from "@/lib/observability/logger"
import { recordDisbursementCommission } from "@/lib/referral-agents/commission"
import { CHANGED, payoutGates, payoutPreconditions, payoutRefusalFrom, refuse, Refused, type PayoutRefusal, type PayoutSubject } from "./payout-gates"
import { KEY_FACTS_BANK_REF_MAX, KEY_FACTS_PAYOUT_NOTE, manualBankRef } from "./payout-terms"

export type KeyFactsDisbursement =
  | { ok: true; loanId: string; loanRef: string; disbursementCents: number; payoutChannel: "MANUAL" }
  | PayoutRefusal

export async function disburseKeyFactsLoan(args: PayoutSubject & {
  /** The reference of the transfer the officer made at the bank. */
  bankRef: unknown
}): Promise<KeyFactsDisbursement> {
  const { tenantId, applicationId, user } = args

  // A refusal is audited by the route (LOAN_DISBURSEMENT_REFUSED, from the response's `disbursementPrecondition`).
  const bankRef = manualBankRef(args.bankRef)
  if (!bankRef) return refuse(422, "bank_reference", `Cannot disburse: record the bank's reference for the manual transfer (1 to ${KEY_FACTS_BANK_REF_MAX} characters).`)
  const pre = await payoutPreconditions(args)
  if (!pre.ok) return pre
  const { clientId, segregation } = pre.scope

  try {
    const booked = await prisma.$transaction(async (tx) => {
      const { at: disbursedAt, current, bank, approval, calculation, statement, verification, repaymentMethod } = await payoutGates(tx, pre.scope)
      const terms = approval.inputs
      const first = calculation.schedule[0]
      const maturityDate = calculation.schedule[calculation.schedule.length - 1].dueDate

      let claim
      try {
        claim = await tx.loanApplication.updateMany({
          where: { id: applicationId, tenantId, status: "APPROVED", updatedAt: current.updatedAt, agreementSignedAt: { not: null } },
          data: {
            status: "DISBURSED", disbursedAt, disbursedById: user.id,
            disbursementBank: bank.bank, disbursementAccountNo: bank.accountNo, disbursementBranchCode: bank.branchCode, disbursementAccountType: bank.accountType,
            disbursementRef: bankRef,
          },
        })
      } catch (error) {
        // The one unique constraint on this write: LoanApplication_key_facts_bank_reference (a reference pays one loan).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new Refused(refuse(409, "bank_reference_used", "Cannot disburse: that bank reference is already recorded against another loan. One transfer pays one loan: check the reference."))
        }
        throw error
      }
      if (claim.count !== 1) throw new Refused(CHANGED)
      const created = await tx.loan.create({
        data: {
          tenantId, applicationId, clientId, productId: current.productId,
          reference: await unusedLoanReference(async (reference) => Boolean(await tx.loan.findFirst({ where: { reference }, select: { id: true } }))),
          principal: calculation.principal, totalInterest: calculation.totalInterest, initiationFee: calculation.initiationFee,
          creditLifePremiums: 0, totalRepayable: calculation.totalRepayable,
          contractualTotalInterest: calculation.totalInterest, contractualTotalRepayable: calculation.totalRepayable,
          outstandingPrincipal: calculation.principal, status: "ACTIVE", startDate: disbursedAt, maturityDate, nextPaymentDate: first.dueDate,
          interestRatePm: terms.interestRatePm, interestModel: terms.interestModel,
          monthlyServiceFee: terms.monthlyServiceFeeCents, agreementDocId: current.agreementDocumentId,
        },
      })
      await tx.repaymentSchedule.createMany({
        data: calculation.schedule.map((item) => ({
          tenantId, loanId: created.id, installmentNo: item.installmentNo, dueDate: item.dueDate, principalDue: item.principalDue, interestDue: item.interestDue,
          creditLifePremiumDue: 0, feesDue: item.feesDue, totalDue: item.totalDue, status: "PENDING" as const,
        })),
      })
      await recordOriginationTerms(tx, { tenantId, loanId: created.id, terms, startDate: new Date(approval.calculator.startDate) })
      await recordDisbursementCommission(tx, { tenantId, loanId: created.id, clientId, principalCents: created.principal })
      const common = { tenantId, userId: user.id, userEmail: user.email }
      await logAuditStrict({
        ...common, action: AuditAction.LOAN_CREATED, entity: "Loan", entityId: created.id,
        newValue: {
          reference: created.reference, applicationId, clientId, productId: current.productId, principal: calculation.principal, totalInterest: calculation.totalInterest,
          initiationFee: calculation.initiationFee, totalRepayable: calculation.totalRepayable, disbursementAmount: calculation.disbursementAmount,
          interestRatePm: created.interestRatePm, interestModel: created.interestModel, startDate: disbursedAt.toISOString(), maturityDate: maturityDate.toISOString(),
          scheduleItems: calculation.schedule.length, regime: "KEY_FACTS",
          ...(terms.productVersion ? { productVersionId: terms.productVersion.id, productVersion: terms.productVersion.version, pricingRuleId: terms.productVersion.pricingRuleId, pricingRuleName: terms.productVersion.pricingRuleName } : {}),
        },
      }, tx)
      await logAuditStrict({
        ...common, action: AuditAction.LOAN_DISBURSED, entity: "LoanApplication", entityId: applicationId,
        newValue: {
          loanId: created.id, loanRef: created.reference, principal: created.principal, segregationOfDuties: segregation, approvedById: current.approvedById,
          agreementDocumentId: current.agreementDocumentId, agreementDocumentSha256: current.agreementDocumentSha256,
          bankStatementDocumentId: statement.documentId, repaymentMethod, decisionFingerprint: approval.decisionFingerprint,
          payoutAccountVerification: { avsCheckId: verification.avsCheckId, verifiedById: verification.verifiedById },
          payoutChannel: "MANUAL", payoutReference: bankRef, payoutNote: KEY_FACTS_PAYOUT_NOTE,
        },
      }, tx)
      // The database re-runs the document gate and the commit-together rule here, inside the transaction.
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return { loan: created, disbursementCents: calculation.disbursementAmount, firstDueDate: first.dueDate }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    triggerNotification({
      tenantId, event: "loan_disbursed", loanId: booked.loan.id,
      data: { amount: booked.disbursementCents, dueDate: new Intl.DateTimeFormat("en-GB").format(booked.firstDueDate) },
    }).catch((error: unknown) => logger.warn("[key-facts] the disbursement notification failed", { applicationId, error: String(error) }))
    return { ok: true, loanId: booked.loan.id, loanRef: booked.loan.reference, disbursementCents: booked.disbursementCents, payoutChannel: "MANUAL" }
  } catch (error) {
    return payoutRefusalFrom(error)
  }
}
