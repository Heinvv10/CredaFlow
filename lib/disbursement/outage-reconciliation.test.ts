import { describe, expect, it } from "vitest"
import { createApplicationContractFixture } from
  "@/lib/compliance/signed-debit-mandate.integration-fixture"
import type { OutageApplicationPolicy } from "./outage-exception"
import {
  buildOutageReconciliationPlan,
  type OutageReconciliationApplication,
} from "./outage-reconciliation"

/**
 * The outage allow-list is intentionally EMPTY in this product, so no real
 * policy exists to pass in. `buildOutageReconciliationPlan` takes its policy as
 * an argument, so these refusal tests hand it a SYNTHETIC one. That cannot
 * re-enable anything: even a plan that clears every cohort and calculator check
 * is refused at the payout date, which is read from the (empty) allow-list.
 */
type CalculatorSource = OutageApplicationPolicy["calculatorSource"]

const IDS: Record<CalculatorSource, { id: string; reference: string }> = {
  CONTRACT: { id: "test-application-0001", reference: "APP-TEST-0001" },
  APPROVAL: { id: "test-application-0002", reference: "APP-TEST-0002" },
}

function syntheticPolicy(source: CalculatorSource): OutageApplicationPolicy {
  return {
    applicationId: IDS[source].id,
    reference: IDS[source].reference,
    incidentId: "test-incident-0001",
    payoutDate: "2026-01-01",
    managementApprovedBy: "Test Approver",
    principalCents: 100_000,
    termDays: 30,
    interestRatePm: 0.05,
    repaymentMethod: "EFT",
    creditLifeElection: "DECLINED",
    disbursementRef: "TEST CLIENT",
    calculatorSource: source,
    expectedPayoutProfile: {
      bankName: "TEST BANK",
      branchCode: "000000",
      accountType: "CHEQUE",
    },
    waivedPreconditions: ["verified_banking"],
  }
}

function applicationFixture(
  source: CalculatorSource,
): OutageReconciliationApplication {
  const contract = source === "CONTRACT"
  const generatedAt = new Date("2026-01-01T08:00:00.000Z")
  const evidence = createApplicationContractFixture({
    applicationId: IDS[source].id,
    productId: "test-product",
    officerId: "approver-1",
    pricing: {
      principal: 100_000,
      termDays: 30,
      productType: "MICRO" as const,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL" as const,
      initiationFeeModel: "FLAT_PCT" as const,
      initiationFeePct: 0.15,
      initiationFeeMax: 100_000,
      monthlyServiceFee: 6_900,
      initiationFeePayment: "DEFERRED" as const,
    },
    quotePresentedAt: generatedAt,
    agreementEstablishedAt: generatedAt,
    acceptedPasqDocumentSha256: "a".repeat(64),
  })

  return {
    id: IDS[source].id,
    tenantId: "tenant-1",
    reference: IDS[source].reference,
    productId: "test-product",
    status: "APPROVED",
    approvedAmount: 100_000,
    approvedTermDays: 30,
    approvedRate: 0.05,
    repaymentMethod: "EFT",
    creditLifeElection: "DECLINED",
    creditLifeProductId: null,
    creditLifeInsurerId: null,
    creditLifeMonthlyPremiumCents: 0,
    affordabilityResult: contract
      ? evidence.affordabilityResult
      : {
          schemaVersion: evidence.affordabilityResult.schemaVersion,
          approval: evidence.affordabilityResult.approval,
        },
    agreementDocumentId: contract ? "test-agreement" : null,
    loan: null,
    coreDocumentsVerified: true,
    client: {
      id: "test-client",
      bankName: "TEST BANK",
      bankAccountNumber: "0000000001",
      bankBranchCode: "000000",
      accountType: "CHEQUE",
    },
    verifiedBankStatements: [{
      documentId: "test-statement",
      documentSha256: "b".repeat(64),
      verifiedAt: new Date("2026-01-01T07:00:00.000Z"),
      bankName: "TEST BANK",
      accountNumber: "0000000001",
      branchCode: "000000",
      accountType: "CHEQUE",
    }],
  }
}

describe("outage reconciliation plan", () => {
  it.each(["CONTRACT", "APPROVAL"] as const)(
    "refuses a %s application that matches its policy, at the payout date",
    (source) => {
      expect(() => buildOutageReconciliationPlan(
        applicationFixture(source),
        syntheticPolicy(source),
      )).toThrow(/approved outage payout date/i)
    },
  )

  it("rejects missing or tampered calculator evidence", () => {
    const missing = applicationFixture("APPROVAL")
    missing.affordabilityResult = null
    expect(() => buildOutageReconciliationPlan(
      missing,
      syntheticPolicy("APPROVAL"),
    )).toThrow(/approval calculator/i)

    const tampered = applicationFixture("CONTRACT")
    const store = tampered.affordabilityResult as {
      contract: { calculator: { totalRepayableCents: number } }
    }
    store.contract.calculator.totalRepayableCents += 1
    expect(() => buildOutageReconciliationPlan(
      tampered,
      syntheticPolicy("CONTRACT"),
    )).toThrow(/contract calculator/i)
  })

  it("refuses agreement evidence on an application policied to the approval calculator", () => {
    const application = {
      ...applicationFixture("APPROVAL"),
      agreementDocumentId: "unexpected-agreement",
    }
    expect(() => buildOutageReconciliationPlan(
      application,
      syntheticPolicy("APPROVAL"),
    )).toThrow(/policied to the approval calculator/i)
  })

  it.each([
    ["amount", { approvedAmount: 99_999 }],
    ["term", { approvedTermDays: 31 }],
    ["rate", { approvedRate: 0.06 }],
    ["method", { repaymentMethod: "DEBIT_ORDER" }],
    ["cover", { creditLifeElection: "ACCEPTED" }],
    ["existing loan", { loan: { id: "already-booked" } }],
    ["reference", { reference: "APP-TEST-9999" }],
    ["status", { status: "DISBURSED" }],
    ["KYC", { coreDocumentsVerified: false }],
  ])("rejects a changed %s", (_label, change) => {
    const application = {
      ...applicationFixture("APPROVAL"),
      ...change,
    } as OutageReconciliationApplication
    expect(() => buildOutageReconciliationPlan(
      application,
      syntheticPolicy("APPROVAL"),
    )).toThrow(/reviewed outage cohort/i)
  })

  it("rejects a client whose account type has drifted from the policy", () => {
    // `exactBankMatch` is a raw string equality, so an OTHER on both sides
    // would assert that two UNKNOWN account types are an exact match. The cohort
    // check runs first and reads `client.accountType`, so a client stored as
    // OTHER must be refused there.
    const application = {
      ...applicationFixture("APPROVAL"),
      client: {
        ...applicationFixture("APPROVAL").client,
        accountType: "OTHER",
      },
    } as unknown as OutageReconciliationApplication

    expect(() => buildOutageReconciliationPlan(
      application,
      syntheticPolicy("APPROVAL"),
    )).toThrow(/reviewed outage cohort/i)
  })

  it("rejects incomplete bank evidence", () => {
    const application = {
      ...applicationFixture("APPROVAL"),
      verifiedBankStatements: [],
    }
    expect(() => buildOutageReconciliationPlan(
      application,
      syntheticPolicy("APPROVAL"),
    )).toThrow(/bank evidence is incomplete/i)
  })
})
