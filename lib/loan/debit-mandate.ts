import { recurringInstalmentDue } from "./instalment"
import {
  debitMandateAccountNumberError,
  debitMandateBankNameError,
  debitMandateBranchCodeError,
} from "./debit-mandate-bank-validation"
import {
  acceptedPasqCalculatorFingerprint,
  affordabilityContractCanBeDisbursed,
  affordabilityContractEvidenceIsIntact,
  readAffordabilitySnapshotStore,
} from "@/lib/affordability/snapshot"
import {
  pasqEvidenceIsIntact,
  type PasqEvidence,
} from "@/lib/compliance/pasq"

type MandateScheduleItem = {
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
}

export type DebitMandatePaymentTerms = {
  paymentFrequency: "ONCE_OFF" | "MONTHLY"
  recurringDebitAmount: number | null
  firstDebitAmount: number
  firstDebitDate: Date
  firstDebitInitiationFee: number
}

export class DebitMandateEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DebitMandateEvidenceError"
  }
}

/**
 * Build the amounts printed on a debit mandate from the persisted repayment
 * schedule. A deferred initiation fee is loaded into instalment 1 only, so the
 * first row is not the recurring debit for a multi-instalment loan.
 */
export function debitMandatePaymentTerms(args: {
  schedule: readonly MandateScheduleItem[]
  principal: number
  totalInterest: number
  totalRepayable: number
  initiationFee: number
  initiationFeePayment: "DEFERRED" | "UPFRONT"
  startDate: Date
  maturityDate: Date
  affordabilityResult: unknown
  /** Verified, acknowledged PASQ v3 evidence for premium-inclusive loans. */
  pasqEvidence?: unknown
}): DebitMandatePaymentTerms {
  const schedule = [...args.schedule].sort((a, b) => a.installmentNo - b.installmentNo)
  if (schedule.length === 0 || schedule[0]?.installmentNo !== 1) {
    throw new DebitMandateEvidenceError("A complete repayment schedule is required before generating a debit mandate.")
  }
  if (schedule.some((item, index) =>
    item.installmentNo !== index + 1
    || !Number.isInteger(item.principalDue)
    || item.principalDue < 0
    || !Number.isInteger(item.interestDue)
    || item.interestDue < 0
    || !Number.isInteger(item.feesDue)
    || item.feesDue < 0
    || !Number.isInteger(item.totalDue)
    || item.totalDue <= 0
    || item.principalDue + item.interestDue + item.feesDue !== item.totalDue
    || !Number.isFinite(item.dueDate.getTime())
  )) {
    throw new DebitMandateEvidenceError("The repayment schedule is invalid and cannot support a debit mandate.")
  }
  if (
    !Number.isInteger(args.principal)
    || args.principal <= 0
    || !Number.isInteger(args.totalInterest)
    || args.totalInterest < 0
    || !Number.isInteger(args.totalRepayable)
    || args.totalRepayable <= 0
    || !Number.isInteger(args.initiationFee)
    || args.initiationFee < 0
    || !Number.isFinite(args.startDate.getTime())
    || !Number.isFinite(args.maturityDate.getTime())
  ) {
    throw new DebitMandateEvidenceError("The loan totals are invalid and cannot support a debit mandate.")
  }

  const store = readAffordabilitySnapshotStore(args.affordabilityResult)
  const approval = store.approval
  const contract = store.contract
  if (
    !approval
    || !contract
    || !affordabilityContractEvidenceIsIntact(contract, approval)
    || approval.inputs.initiationFeePayment !== args.initiationFeePayment
  ) {
    throw new DebitMandateEvidenceError(
      "Immutable signed repayment evidence is missing or invalid.",
    )
  }
  const immutable = contract.calculator
  let pasqEvidence: PasqEvidence | null = null
  if (args.pasqEvidence !== undefined) {
    if (!pasqEvidenceIsIntact(args.pasqEvidence)) {
      throw new DebitMandateEvidenceError(
        "The acknowledged PASQ billing evidence is missing or invalid.",
      )
    }
    pasqEvidence = args.pasqEvidence
  }
  if (
    pasqEvidence
    && pasqEvidence.calculator.contractFingerprint
      !== acceptedPasqCalculatorFingerprint(contract)
  ) {
    throw new DebitMandateEvidenceError(
      "The acknowledged PASQ does not match the immutable signed repayment evidence.",
    )
  }
  const contractStart = new Date(contract.establishedAt)
  if (
    pasqEvidence
    && pasqEvidence.billing.schedule.length !== immutable.schedule.length
  ) {
    throw new DebitMandateEvidenceError(
      "The acknowledged PASQ schedule differs from the immutable signed agreement.",
    )
  }
  const expectedSchedule = pasqEvidence
    ? pasqEvidence.billing.schedule.map((item, index) => {
        const contractItem = immutable.schedule[index]
        if (
          !contractItem
          || contractItem.installmentNo !== item.installmentNo
        ) {
          throw new DebitMandateEvidenceError(
            "The acknowledged PASQ schedule differs from the immutable signed agreement.",
          )
        }
        return {
          ...item,
          dueDate: contractItem.dueDate,
        }
      })
    : immutable.schedule
  const expectedMaturity = expectedSchedule.at(-1)?.dueDate
  const expectedTotalRepayable = pasqEvidence?.billing.totalRepayableCents
    ?? immutable.totalRepayableCents
  if (
    expectedSchedule.length === 0
    || (
      pasqEvidence
        // This module exists only for debit orders, so the same-day rule
        // always applies here: the mandate being built authorises collection on
        // these exact dates and cannot be amended once signed.
        ? !affordabilityContractCanBeDisbursed(contract, args.startDate, "DEBIT_ORDER")
        : contractStart.getTime() !== args.startDate.getTime()
    )
    || !expectedMaturity
    || new Date(expectedMaturity).getTime() !== args.maturityDate.getTime()
    || immutable.principalCents !== args.principal
    || immutable.totalInterestCents !== args.totalInterest
    || immutable.initiationFeeCents !== args.initiationFee
    || expectedTotalRepayable !== args.totalRepayable
    || expectedSchedule.length !== schedule.length
  ) {
    throw new DebitMandateEvidenceError(
      "The loan and repayment schedule do not match the immutable signed repayment evidence.",
    )
  }
  if (schedule.some((item, index) => {
    const expected = expectedSchedule[index]
    return !expected
      || item.installmentNo !== expected.installmentNo
      || item.dueDate.getTime() !== new Date(expected.dueDate).getTime()
      || item.principalDue !== expected.principalDueCents
      || item.interestDue !== expected.interestDueCents
      || item.feesDue !== expected.feesDueCents
      || item.totalDue !== expected.totalDueCents
  })) {
    throw new DebitMandateEvidenceError(
      "The persisted repayment schedule differs from the immutable signed repayment evidence.",
    )
  }
  const scheduledPrincipal = schedule.reduce((sum, item) => sum + item.principalDue, 0)
  const scheduledInterest = schedule.reduce((sum, item) => sum + item.interestDue, 0)
  const scheduledFees = schedule.reduce((sum, item) => sum + item.feesDue, 0)
  const scheduledTotal = schedule.reduce((sum, item) => sum + item.totalDue, 0)
  if (
    scheduledPrincipal !== args.principal
    || scheduledInterest !== args.totalInterest
    || scheduledTotal !== args.totalRepayable
    || scheduledFees !== args.totalRepayable - args.principal - args.totalInterest
  ) {
    throw new DebitMandateEvidenceError(
      "The repayment schedule does not reconcile to the loan totals.",
    )
  }
  const expectedScheduledFees = immutable.serviceFeesCents + (
    args.initiationFeePayment === "DEFERRED" ? args.initiationFee : 0
  ) + (pasqEvidence?.creditLife.totalPremiumCents ?? 0)
  if (scheduledFees !== expectedScheduledFees) {
    throw new DebitMandateEvidenceError(
      "The scheduled fees do not reconcile to the immutable service and initiation fees.",
    )
  }

  const firstDebitAmount = schedule[0].totalDue
  const paymentFrequency = schedule.length === 1 ? "ONCE_OFF" : "MONTHLY"
  const recurringDebitAmount = paymentFrequency === "MONTHLY"
    ? recurringInstalmentDue(schedule)
    : null
  const firstDebitInitiationFee = args.initiationFeePayment === "DEFERRED"
    ? args.initiationFee
    : 0
  if (firstDebitInitiationFee > firstDebitAmount) {
    throw new DebitMandateEvidenceError("The deferred initiation fee exceeds the first scheduled debit.")
  }
  if (
    args.initiationFeePayment === "DEFERRED"
    && schedule[0].feesDue < args.initiationFee
  ) {
    throw new DebitMandateEvidenceError(
      "The first scheduled debit does not contain the deferred initiation fee.",
    )
  }
  if (recurringDebitAmount !== null) {
    const roundingToleranceCents = 100
    if (schedule.slice(1).some((item) =>
      Math.abs(item.totalDue - recurringDebitAmount) > roundingToleranceCents
    )) {
      throw new DebitMandateEvidenceError(
        "The repayment schedule does not contain a consistent recurring debit.",
      )
    }
    const expectedFirstDebitUplift = args.initiationFeePayment === "DEFERRED"
      ? args.initiationFee
      : 0
    if (
      Math.abs(
        (firstDebitAmount - recurringDebitAmount) - expectedFirstDebitUplift,
      ) > roundingToleranceCents
    ) {
      throw new DebitMandateEvidenceError(
        "The first scheduled debit does not reconcile to the initiation-fee election.",
      )
    }
    const recurringFeesDue = schedule[1].feesDue
    if (
      schedule.slice(1).some((item) => item.feesDue !== recurringFeesDue)
      || schedule[0].feesDue - recurringFeesDue !== expectedFirstDebitUplift
    ) {
      throw new DebitMandateEvidenceError(
        "The scheduled fee components do not reconcile to the initiation-fee election.",
      )
    }
  }

  return {
    paymentFrequency,
    recurringDebitAmount,
    firstDebitAmount,
    firstDebitDate: schedule[0].dueDate,
    firstDebitInitiationFee,
  }
}

export type DebitMandateBankDetails = {
  bankName: string
  branchCode: string
  accountNumber: string
  accountType: "CHEQUE" | "SAVINGS"
}

export function requireDebitMandateBankDetails(client: {
  firstName: string
  lastName: string
  bankName: string | null
  bankBranchCode: string | null
  bankAccountNumber: string | null
  accountType: string | null
}): DebitMandateBankDetails {
  const bankName = client.bankName?.trim()
  const branchCode = client.bankBranchCode?.trim()
  const accountNumber = client.bankAccountNumber?.trim()
  const accountType = client.accountType?.trim()
  const accountHolderName = `${client.firstName.trim()} ${client.lastName.trim()}`.trim()
  if (
    !accountHolderName
    || accountHolderName.length > 120
    || !bankName
    || debitMandateBankNameError(bankName) !== null
    || !branchCode
    || debitMandateBranchCodeError(branchCode) !== null
    || !accountNumber
    || debitMandateAccountNumberError(accountNumber) !== null
    || (accountType !== "CHEQUE" && accountType !== "SAVINGS")
  ) {
    throw new DebitMandateEvidenceError(
      "Complete on-file banking details are required before generating a debit mandate.",
    )
  }
  return { bankName, branchCode, accountNumber, accountType }
}
