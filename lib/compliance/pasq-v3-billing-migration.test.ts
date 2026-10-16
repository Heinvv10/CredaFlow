import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
  baselineTriggerSql,
  readBaselineSql,
} from "../db-baseline.test-helpers"

/** The `CREATE TABLE "name" ( … );` block from the baseline's DDL half. */
function tableSql(name: string): string {
  const match = readBaselineSql().match(
    new RegExp(`^CREATE TABLE "${name}" \\([\\s\\S]*?^\\);`, "m"),
  )
  if (!match) throw new Error(`table ${name} is not in the baseline`)
  return match[0]
}

const approvedRequiresPasq = baselineConstraintSql(
  "LoanApplication_approved_status_requires_pasq",
)
const branchSigner = baselineFunctionSql("guardLoanApplicationBranchSignerTenant")
const evidenceDigest = baselineFunctionSql("pasqEvidenceSha256V3")
const billing = baselineFunctionSql("validateLoanPasqV3Billing")
const scheduleDates = baselineFunctionSql("validateLoanPasqV3ScheduleDates")
const loanGuards = [
  baselineFunctionSql("guardLoanPasqV3Billing"),
  baselineFunctionSql("guardLoanPasqV3ScheduleDates"),
].join("\n")
const scheduleGuards = [
  baselineFunctionSql("guardRepaymentSchedulePasqV3Billing"),
  baselineFunctionSql("guardRepaymentSchedulePasqV3Dates"),
].join("\n")

describe("PASQ v3 billing database migration", () => {
  it("requires a tenant-bound authorised branch witness", () => {
    expect(
      baselineConstraintSql("LoanApplication_tenantId_agreementSignedByUserId_fkey"),
    ).toContain(`FOREIGN KEY ("tenantId", "agreementSignedByUserId")`)
    expect(branchSigner).toContain(
      `CREATE OR REPLACE FUNCTION public."guardLoanApplicationBranchSignerTenant"`,
    )
    expect(branchSigner).toContain(`NEW."agreementSignedMethod" = 'branch'`)
    expect(branchSigner).toContain(`signer."tenantId" = NEW."tenantId"`)
    expect(branchSigner).toContain(`signer."active" = TRUE`)
    expect(branchSigner).toContain(`'CREDIT_OFFICER'::"UserRole"`)
  })

  it("recomputes the complete v3 evidence digest inside PostgreSQL", () => {
    expect(evidenceDigest).toContain(
      `CREATE OR REPLACE FUNCTION public."pasqEvidenceSha256V3"`,
    )
    expect(evidenceDigest).toContain(`'pasq-evidence-envelope-v3'`)
    expect(evidenceDigest).toContain(`'{billing,recurringPaymentCents}'`)
    expect(evidenceDigest).toContain(
      `schedule_item ->> 'creditLifePremiumDueCents'`,
    )
    expect(approvedRequiresPasq).toContain(
      `"pasqEvidenceSha256V3"("pasqEvidence")`,
    )
    expect(approvedRequiresPasq).toContain(`("pasqVersion" = 'pasq-v3'::text)`)
  })

  it("binds premium-inclusive loan and schedule money at deferred commit", () => {
    expect(tableSql("Loan")).toContain(
      `"creditLifePremiums" INTEGER NOT NULL DEFAULT 0,`,
    )
    expect(tableSql("RepaymentSchedule")).toContain(
      `"creditLifePremiumDue" INTEGER NOT NULL DEFAULT 0,`,
    )
    expect(billing).toContain(
      `CREATE OR REPLACE FUNCTION public."validateLoanPasqV3Billing"`,
    )
    expect(billing).toContain(
      `evidence_total_repayable :=\n    (booked."pasqEvidence" #>> '{billing,totalRepayableCents}')::INTEGER;`,
    )
    expect(billing).toContain(
      `booked."totalRepayable" <> evidence_total_repayable`,
    )
    expect(billing).toContain(
      `actual."creditLifePremiumDue"`,
    )
    expect(baselineTriggerSql("Loan_guard_pasq_v3_billing")).toMatch(
      /^CREATE CONSTRAINT TRIGGER "Loan_guard_pasq_v3_billing"[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
    )
    expect(baselineTriggerSql("RepaymentSchedule_guard_pasq_v3_billing")).toMatch(
      /^CREATE CONSTRAINT TRIGGER "RepaymentSchedule_guard_pasq_v3_billing"[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
    )
  })

  it("locks the PASQ, uses a data-driven holiday calendar, and binds the signed dates", () => {
    const lockPasq = baselineFunctionSql("lockLoanApplicationPasqDocument")
    expect(lockPasq).toContain(
      `CREATE OR REPLACE FUNCTION public."lockLoanApplicationPasqDocument"`,
    )
    expect(lockPasq).toContain(`FOR SHARE;`)
    expect(baselineFunctionSql("quoteValidUntilDate")).toContain(
      `CREATE OR REPLACE FUNCTION public."quoteValidUntilDate"`,
    )
    const businessDate = baselineFunctionSql("isSaBusinessDate")
    expect(businessDate).toContain(
      `CREATE OR REPLACE FUNCTION public."isSaBusinessDate"`,
    )
    expect(readBaselineSql()).toContain(
      `CREATE TABLE "SaProclaimedPublicHoliday"`,
    )
    expect(readBaselineSql()).toMatch(
      /INSERT INTO "SaProclaimedPublicHoliday" [^;]*DATE '2024-05-29'/,
    )
    expect(businessDate).toContain(
      `WHERE proclaimed."date" = p_date - 1`,
    )
    expect(scheduleDates).toContain(
      `actual."dueDate" <>`,
    )
    expect(scheduleDates).toContain(
      `total_offset := agreement_offset + payout_offset`,
    )
    expect(scheduleDates).toContain(
      `) + total_offset`,
    )
    expect(scheduleDates).toContain(
      `booked."agreementGeneratedAt"`,
    )
    expect(baselineTriggerSql("RepaymentSchedule_guard_pasq_v3_dates")).toMatch(
      /^CREATE CONSTRAINT TRIGGER "RepaymentSchedule_guard_pasq_v3_dates"[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
    )
  })

  it("revalidates PASQ v3 only when protected booking fields change", () => {
    expect(loanGuards).toContain(
      `CREATE OR REPLACE FUNCTION public."guardLoanPasqV3Billing"`,
    )
    expect(loanGuards).toContain(
      `OLD."totalRepayable" IS DISTINCT FROM NEW."totalRepayable"`,
    )
    expect(loanGuards).not.toContain(
      `OLD."lastPaymentAmount" IS DISTINCT FROM NEW."lastPaymentAmount"`,
    )
    expect(loanGuards).toContain(
      `OLD."maturityDate" IS DISTINCT FROM NEW."maturityDate"`,
    )
    expect(scheduleGuards).toContain(
      `CREATE OR REPLACE FUNCTION public."guardRepaymentSchedulePasqV3Billing"`,
    )
    expect(scheduleGuards).toContain(
      `OLD."totalDue" IS DISTINCT FROM NEW."totalDue"`,
    )
    expect(scheduleGuards).not.toContain(
      `OLD."totalPaid" IS DISTINCT FROM NEW."totalPaid"`,
    )
    expect(scheduleGuards).toContain(
      `OLD."dueDate" IS DISTINCT FROM NEW."dueDate"`,
    )
  })

  it("permits only an audited, ledger-balanced DAILY_ACCRUAL rebate", () => {
    expect(billing).toContain(
      `booked."interestModel" = 'DAILY_ACCRUAL'::"InterestModel"`,
    )
    expect(billing).toContain(
      `booked."contractualTotalRepayable" = evidence_total_repayable`,
    )
    expect(billing).toContain(
      `allocated_payment_total <> booked."totalPaid"`,
    )
    expect(billing).toContain(
      `audit."newValue" ->> 'earlyDailySettlement' = 'true'`,
    )
    expect(billing).toContain(
      `audit."newValue" ->> 'settlementDue'`,
    )
    expect(loanGuards).toContain(
      `OLD."contractualTotalRepayable"`,
    )
  })

  it("permits an audited s125 early settlement of an instalment loan, against the PASQ and the recorded contract", () => {
    // Re-created by 20261016200000_s125_instalment_settlement: the latest definition.
    expect(billing).toContain(`early_instalment_settlement :=`)
    expect(billing).toContain(`booked."interestModel" <> 'DAILY_ACCRUAL'::"InterestModel"`)
    expect(billing).toContain(`actual."interestDue"\n                > (expected ->> 'interestDueCents')::INTEGER`)
    expect(billing).toContain(`actual."principalDue"\n            <> (expected ->> 'principalDueCents')::INTEGER`)
    expect(billing).toContain(`actual_premium_due > booked."creditLifePremiums"`)
    expect(billing).toContain(`audit."newValue" ->> 'earlyInstalmentSettlement' = 'true'`)
    expect(billing).toContain(`audit."newValue" ->> 'loanId' = booked."id"`)
    expect(billing).toContain(`recorded ->> 'totalDue' = expected ->> 'totalDueCents'`)
    // Only a receipt writer's audit row, naming this loan's live receipt of
    // exactly the settlement figure; rows due by its value date owed whole.
    expect(billing).toContain(`audit."action" IN ('PAYMENT_RECORDED', 'SMALL_BALANCE_WAIVED')`)
    expect(billing).toContain(`audit."entityId" = payment."id"`)
    expect(billing).toContain(`deposit."paymentId" = payment."id"`)
    expect(billing).toContain(`AND payment."reversed" = FALSE`)
    expect(billing).toContain(`END = payment."amount"`)
    expect(billing).toContain(`ON own."id" = recorded ->> 'id'`)
    expect(billing).toContain(`<= settle_day`)
    expect(billing).toContain(`actual."creditLifePremiumDue" <> 0`)
    expect(baselineConstraintSql("AuditLog_settlement_evidence_receipts_only")).toContain(`"newValue" -> 'earlyInstalmentSettlement' IS NULL`)
    expect(billing).toContain(`Early instalment settlement does not preserve PASQ v3 contractual and ledger evidence`)
    // The DAILY_ACCRUAL rebate and the full PASQ comparison are kept as they were.
    expect(billing).toContain(`audit."newValue" ->> 'earlyDailySettlement' = 'true'`)
    expect(billing).toContain(`Repayment schedule does not match the acknowledged PASQ v3 billing evidence`)
  })
})
