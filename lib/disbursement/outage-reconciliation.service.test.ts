import { describe, expect, it, vi } from "vitest"
import {
  reconcileOutageDisbursements,
  type OutageLoadedApplication,
  type OutageReconciliationDependencies,
} from "./outage-reconciliation"

/**
 * The outage allow-list is intentionally EMPTY in this product, so the service
 * refuses every incident before it opens a transaction. The loader below would
 * hand back a well-formed synthetic application if it were ever asked; the
 * assertions prove it never is, and that nothing is written.
 */
const APPLICATION_ID = "test-application-0001"

function loadedApplication(): OutageLoadedApplication {
  return {
    id: APPLICATION_ID,
    tenantId: "tenant-1",
    reference: "APP-TEST-0001",
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
    affordabilityResult: null,
    agreementDocumentId: null,
    loan: null,
    coreDocumentsVerified: true,
    client: {
      id: "test-client",
      bankName: "TEST BANK",
      bankAccountNumber: "0000000001",
      bankBranchCode: "000000",
      accountType: "CHEQUE",
    },
    verifiedBankStatements: [],
    disbursedAt: null,
    disbursementExceptionId: null,
    disbursementException: null,
  }
}

function dependencies() {
  const tx = {
    complianceRecord: { create: vi.fn() },
    loanApplication: { updateMany: vi.fn() },
    loan: { create: vi.fn() },
    repaymentSchedule: { createMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
  }
  const loadApplication = vi.fn(async () => loadedApplication())
  const recordCommission = vi.fn(async () => undefined)
  const prisma = {
    $transaction: vi.fn(async (
      callback: (transaction: typeof tx) => Promise<unknown>,
    ) => callback(tx)),
  }
  return {
    tx,
    prisma,
    loadApplication,
    recordCommission,
    deps: {
      prisma,
      loadApplication,
      recordCommission,
      now: () => new Date("2026-01-02T09:30:00.000Z"),
    } as unknown as OutageReconciliationDependencies,
  }
}

const args = {
  tenantId: "tenant-1",
  operator: { id: "super-admin-1", email: "operator@example.test" },
  managementApprovalNote:
    "Test Approver approved the formal outage reconciliation.",
}

describe("reconcileOutageDisbursements", () => {
  it.each([
    ["dry-run", false],
    ["apply", true],
  ])("refuses every incident in %s mode without opening a transaction", async (
    _label,
    apply,
  ) => {
    for (const incidentId of ["test-incident-0001", "", "constructor"]) {
      const setup = dependencies()

      await expect(reconcileOutageDisbursements(
        { ...args, incidentId, apply },
        setup.deps,
      )).rejects.toThrow(/unknown outage incident/i)

      expect(setup.prisma.$transaction).not.toHaveBeenCalled()
      expect(setup.loadApplication).not.toHaveBeenCalled()
      expect(setup.tx.complianceRecord.create).not.toHaveBeenCalled()
      expect(setup.tx.loanApplication.updateMany).not.toHaveBeenCalled()
      expect(setup.tx.loan.create).not.toHaveBeenCalled()
      expect(setup.tx.auditLog.create).not.toHaveBeenCalled()
      expect(setup.recordCommission).not.toHaveBeenCalled()
    }
  })

  it("refuses at the incident gate even with an unreasoned management note", async () => {
    const setup = dependencies()

    await expect(reconcileOutageDisbursements(
      {
        ...args,
        incidentId: "test-incident-0001",
        managementApprovalNote: "too short",
        apply: true,
      },
      setup.deps,
    )).rejects.toThrow(/unknown outage incident/i)
    expect(setup.prisma.$transaction).not.toHaveBeenCalled()
  })
})
