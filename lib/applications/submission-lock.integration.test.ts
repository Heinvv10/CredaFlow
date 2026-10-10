/**
 * Real-Postgres proof that affordability evidence locks serialize concurrent
 * writers and that mandatory audit inserts are atomic with submission,
 * policy, assessment, and disbursement mutations.
 *
 * Run only against a migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/applications/submission-lock.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Prisma, PrismaClient } from "@prisma/client"
import {
  lockAffordabilityClientEvidence,
  lockAffordabilityTenantPolicy,
} from "@/lib/affordability/evidence-locks"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  createSubmissionAffordabilitySnapshot,
  readAffordabilitySnapshotStore,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import {
  lockExistingApplicationSubmissionEvidence,
  lockNewApplicationSubmissionEvidence,
  type ApplicationSubmissionTransaction,
} from "./submission-lock"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import {
  createApprovedPasqV3Application,
  writePasqV3Disbursement,
} from "@/lib/compliance/pasq-v3-application.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("application submission evidence locking", () => {
  const submissionDb = new PrismaClient()
  const clientWriter = new PrismaClient()
  const productWriter = new PrismaClient()
  const token = randomUUID().replaceAll("-", "")
  const ids = {
    tenant: `tenant_snapshot_${token}`,
    client: `client_snapshot_${token}`,
    product: `product_snapshot_${token}`,
    application: `application_snapshot_${token}`,
    avs: `avs_snapshot_${token}`,
    selfie: `selfie_snapshot_${token}`,
  }

  beforeAll(async () => {
    await submissionDb.tenant.create({
      data: { id: ids.tenant, slug: `snapshot-${token}`, name: "Snapshot Lock Test" },
    })
    await submissionDb.client.create({
      data: {
        id: ids.client,
        tenantId: ids.tenant,
        reference: `CLI-${token}`,
        idNumber: token.slice(0, 13),
        firstName: "Synthetic",
        lastName: "Snapshot",
        email: `snapshot-${token}@test.invalid`,
        phone: "+27820000000",
        grossMonthlyIncome: 1_700_000,
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        expenseBreakdown: {
          create: {
            housing: 400_000,
            transport: 100_000,
            food: 200_000,
            education: 0,
            insurance: 50_000,
            clothing: 0,
            entertainment: 0,
            medical: 50_000,
            other: 0,
          },
        },
      },
    })
    await submissionDb.clientDocument.createMany({
      data: ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"].map(
        (docType, index) => ({
          id: `core_snapshot_${index}_${token}`,
          tenantId: ids.tenant,
          clientId: ids.client,
          docType: docType as "ID_COPY" | "PROOF_OF_ADDRESS" | "PAYSLIP" | "BANK_STATEMENT",
          fileUrl: "",
          fileName: `${docType.toLowerCase()}.pdf`,
          verified: true,
          verifiedAt: new Date(),
        }),
      ),
    })
    await submissionDb.clientDocument.create({
      data: {
        id: ids.selfie,
        tenantId: ids.tenant,
        clientId: ids.client,
        docType: "SELFIE",
        fileUrl: "",
        fileName: "selfie.jpg",
        verified: true,
        verifiedAt: new Date(),
        extractionStatus: "done",
        extractionResult: {
          faceDetected: { value: true },
          facesCount: { value: 1 },
          isLive: { value: true },
          quality: { value: "good" },
        },
        validationMismatch: false,
        validationScore: 98,
        biometricMatchScore: 98,
        biometricLiveness: 97,
        biometricVerifiedAt: new Date(),
        biometricResult: {
          ok: true,
          verified: true,
          matchScore: 98,
          livenessScore: 97,
          subjectFingerprint: biometricSubjectFingerprint({
            id: ids.client,
            idNumber: token.slice(0, 13),
            firstName: "Synthetic",
            lastName: "Snapshot",
            dateOfBirth: null,
          }),
        },
      },
    })
    await submissionDb.loanProduct.create({
      data: {
        id: ids.product,
        tenantId: ids.tenant,
        code: `SNAP-${token}`,
        name: "Snapshot Lock Product",
        productType: "PERSONAL",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
        initiationFeePct: 0.15,
        initiationFeeMax: 105_000,
        monthlyServiceFee: 6_900,
      },
    })
  })

  afterAll(async () => {
    await submissionDb.avsCheck.deleteMany({ where: { id: ids.avs } })
    await submissionDb.auditLog.deleteMany({ where: { entityId: ids.application } })
    await submissionDb.tenantConfig.deleteMany({ where: { tenantId: ids.tenant } })
    await submissionDb.loanApplication.deleteMany({ where: { tenantId: ids.tenant } })
    await submissionDb.loanProduct.deleteMany({ where: { tenantId: ids.tenant } })
    await submissionDb.clientDocument.deleteMany({ where: { clientId: ids.client } })
    await submissionDb.clientExpenseBreakdown.deleteMany({ where: { clientId: ids.client } })
    await submissionDb.client.deleteMany({ where: { tenantId: ids.tenant } })
    await submissionDb.tenant.deleteMany({ where: { id: ids.tenant } })
    await Promise.all([
      submissionDb.$disconnect(),
      clientWriter.$disconnect(),
      productWriter.$disconnect(),
    ])
  })

  it("commits the locked old inputs before both concurrent writers can proceed", async () => {
    let announceLocked!: () => void
    const locked = new Promise<void>((resolve) => { announceLocked = resolve })
    let releaseSubmission!: () => void
    const release = new Promise<void>((resolve) => { releaseSubmission = resolve })

    const submission = submissionDb.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as ApplicationSubmissionTransaction
      expect(await lockNewApplicationSubmissionEvidence(tx, {
        tenantId: ids.tenant,
        clientId: ids.client,
        productId: ids.product,
      })).toBe(true)

      const [client, product] = await Promise.all([
        rawTx.client.findUniqueOrThrow({
          where: { id: ids.client },
          include: { debtObligations: true, expenseBreakdown: true },
        }),
        rawTx.loanProduct.findUniqueOrThrow({ where: { id: ids.product } }),
      ])
      announceLocked()
      await release

      const submittedAt = new Date()
      const snapshot = createSubmissionAffordabilitySnapshot({
        capturedAt: submittedAt,
        capturedById: "officer-lock-test",
        client,
        applicationDebts: [],
        clientDebts: client.debtObligations,
        application: {
          appliedAmount: 500_000,
          appliedTermDays: 30,
          productId: product.id,
          initiationFeePayment: "DEFERRED",
        },
        product: {
          productType: "MICRO",
          interestRatePm: product.interestRatePm,
          interestModel: product.interestModel,
          initiationFeeModel: product.initiationFeeModel,
          initiationFeePct: product.initiationFeePct,
          initiationFeeMax: product.initiationFeeMax,
          monthlyServiceFee: product.monthlyServiceFee,
        },
      })
      await rawTx.loanApplication.create({
        data: {
          id: ids.application,
          tenantId: ids.tenant,
          reference: `APP-${token}`,
          clientId: ids.client,
          productId: ids.product,
          appliedAmount: 500_000,
          appliedTermDays: 30,
          status: "SUBMITTED",
          submittedAt,
          netDisposableIncome: snapshot.outcome.netDisposableIncomeCents,
          affordabilityNDI: snapshot.outcome.ndiAfterLoanCents,
          affordabilityResult: withAffordabilitySnapshot(
            null,
            snapshot,
          ) as unknown as Prisma.InputJsonValue,
        },
      })
      await rawTx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          action: "APPLICATION_SUBMITTED_BY_STAFF",
          entity: "LoanApplication",
          entityId: ids.application,
          newValue: {
            snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
            decisionFingerprint: snapshot.decisionFingerprint,
          },
        },
      })
    })

    await locked

    let clientWriteFinished = false
    const clientWrite = clientWriter.$transaction(async (tx) => {
      await lockAffordabilityClientEvidence(tx, {
        tenantId: ids.tenant,
        clientId: ids.client,
      })
      await tx.client.update({
        where: { id: ids.client },
        data: { monthlyIncome: 1_600_000 },
      })
      clientWriteFinished = true
    })
    let productWriteFinished = false
    const productWrite = productWriter.loanProduct.update({
      where: { id: ids.product },
      data: { interestRatePm: 0.05 },
    }).then(() => { productWriteFinished = true })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(clientWriteFinished).toBe(false)
    expect(productWriteFinished).toBe(false)

    releaseSubmission()
    await Promise.all([submission, clientWrite, productWrite])

    const [application, submissionAudit] = await Promise.all([
      submissionDb.loanApplication.findUniqueOrThrow({
        where: { id: ids.application },
        select: { affordabilityResult: true },
      }),
      submissionDb.auditLog.findFirstOrThrow({
        where: {
          tenantId: ids.tenant,
          action: "APPLICATION_SUBMITTED_BY_STAFF",
          entityId: ids.application,
        },
      }),
    ])
    const snapshot = readAffordabilitySnapshotStore(application.affordabilityResult).submission
    expect(snapshot?.inputs.monthlyIncomeCents).toBe(1_500_000)
    expect(snapshot?.inputs.interestRatePm).toBe(0.03)
    expect(submissionAudit.newValue).toEqual({
      snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
      decisionFingerprint: snapshot?.decisionFingerprint,
    })

    const [currentClient, currentProduct] = await Promise.all([
      submissionDb.client.findUniqueOrThrow({ where: { id: ids.client } }),
      submissionDb.loanProduct.findUniqueOrThrow({ where: { id: ids.product } }),
    ])
    expect(currentClient.monthlyIncome).toBe(1_600_000)
    expect(currentProduct.interestRatePm).toBe(0.05)
  })

  it("serializes existing-application assessment inputs and commits its audit atomically", async () => {
    let announceLocked!: () => void
    const locked = new Promise<void>((resolve) => { announceLocked = resolve })
    let releaseAssessment!: () => void
    const release = new Promise<void>((resolve) => { releaseAssessment = resolve })

    const assessment = submissionDb.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as ApplicationSubmissionTransaction
      const identity = await lockExistingApplicationSubmissionEvidence(tx, {
        tenantId: ids.tenant,
        applicationId: ids.application,
      })
      expect(identity).toEqual({
        id: ids.application,
        clientId: ids.client,
        productId: ids.product,
        evidenceExists: true,
      })

      const application = await rawTx.loanApplication.findUniqueOrThrow({
        where: { id: ids.application },
        include: { client: true, product: true },
      })
      const captured = {
        monthlyIncomeCents: application.client.monthlyIncome,
        interestRatePm: application.product.interestRatePm,
      }
      announceLocked()
      await release

      await rawTx.loanApplication.update({
        where: { id: ids.application },
        data: {
          affordabilityResult: {
            assessmentLockProbe: captured,
          },
        },
      })
      await rawTx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          action: "AFFORDABILITY_ASSESSED",
          entity: "LoanApplication",
          entityId: ids.application,
          newValue: captured,
        },
      })
      return captured
    })

    await locked

    let clientWriteFinished = false
    const clientWrite = clientWriter.$transaction(async (tx) => {
      await lockAffordabilityClientEvidence(tx, {
        tenantId: ids.tenant,
        clientId: ids.client,
      })
      await tx.client.update({
        where: { id: ids.client },
        data: { monthlyIncome: 1_650_000 },
      })
      clientWriteFinished = true
    })
    let productWriteFinished = false
    const productWrite = productWriter.loanProduct.update({
      where: { id: ids.product },
      data: { interestRatePm: 0.06 },
    }).then(() => { productWriteFinished = true })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(clientWriteFinished).toBe(false)
    expect(productWriteFinished).toBe(false)

    releaseAssessment()
    const [captured] = await Promise.all([assessment, clientWrite, productWrite])
    expect(captured).toEqual({
      monthlyIncomeCents: 1_600_000,
      interestRatePm: 0.05,
    })

    const [storedApplication, storedAudit, currentClient, currentProduct] = await Promise.all([
      submissionDb.loanApplication.findUniqueOrThrow({
        where: { id: ids.application },
        select: { affordabilityResult: true },
      }),
      submissionDb.auditLog.findFirstOrThrow({
        where: {
          tenantId: ids.tenant,
          action: "AFFORDABILITY_ASSESSED",
          entityId: ids.application,
        },
        orderBy: { createdAt: "desc" },
      }),
      submissionDb.client.findUniqueOrThrow({ where: { id: ids.client } }),
      submissionDb.loanProduct.findUniqueOrThrow({ where: { id: ids.product } }),
    ])
    expect(storedApplication.affordabilityResult).toEqual({
      assessmentLockProbe: captured,
    })
    expect(storedAudit.newValue).toEqual(captured)
    expect(currentClient.monthlyIncome).toBe(1_650_000)
    expect(currentProduct.interestRatePm).toBe(0.06)
  })

  it("rolls back an assessment mutation when its mandatory audit insert fails", async () => {
    const before = await submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { totalExistingDebt: true },
    })

    await expect(submissionDb.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as ApplicationSubmissionTransaction
      const identity = await lockExistingApplicationSubmissionEvidence(tx, {
        tenantId: ids.tenant,
        applicationId: ids.application,
      })
      expect(identity?.evidenceExists).toBe(true)
      await rawTx.loanApplication.update({
        where: { id: ids.application },
        data: { totalExistingDebt: 123_456 },
      })
      await rawTx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          userId: `missing-user-${token}`,
          action: "AFFORDABILITY_ASSESSED",
          entity: "LoanApplication",
          entityId: ids.application,
        },
      })
    })).rejects.toThrow()

    await expect(submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { totalExistingDebt: true },
    })).resolves.toEqual(before)
  })

  it("rolls back a SUBMITTED transition when its mandatory audit insert fails", async () => {
    await submissionDb.loanApplication.update({
      where: { id: ids.application },
      data: { status: "DRAFT", submittedAt: null },
    })
    const before = await submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { status: true, submittedAt: true, affordabilityResult: true },
    })

    await expect(submissionDb.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as ApplicationSubmissionTransaction
      const identity = await lockExistingApplicationSubmissionEvidence(tx, {
        tenantId: ids.tenant,
        applicationId: ids.application,
      })
      expect(identity?.evidenceExists).toBe(true)
      await rawTx.loanApplication.update({
        where: { id: ids.application },
        data: {
          status: "SUBMITTED",
          submittedAt: new Date(),
          affordabilityResult: { submissionAuditProbe: true },
        },
      })
      await rawTx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          userId: `missing-user-${token}`,
          action: "APPLICATION_SUBMITTED_BY_STAFF",
          entity: "LoanApplication",
          entityId: ids.application,
        },
      })
    })).rejects.toThrow()

    await expect(submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { status: true, submittedAt: true, affordabilityResult: true },
    })).resolves.toEqual(before)
  })

  it("rolls back a decline when its mandatory decision audit insert fails", async () => {
    await submissionDb.loanApplication.update({
      where: { id: ids.application },
      data: { status: "UNDER_REVIEW", decisionReason: null },
    })
    const before = await submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { status: true, decisionReason: true },
    })

    await expect(submissionDb.$transaction(async (tx) => {
      await tx.loanApplication.update({
        where: { id: ids.application },
        data: { status: "DECLINED", decisionReason: "Decline rollback probe" },
      })
      await tx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          userId: `missing-user-${token}`,
          action: "LOAN_DECLINED",
          entity: "LoanApplication",
          entityId: ids.application,
        },
      })
    })).rejects.toThrow()

    await expect(submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { status: true, decisionReason: true },
    })).resolves.toEqual(before)
  })

  it("rolls back a cancellation when its mandatory audit insert fails", async () => {
    await submissionDb.loanApplication.update({
      where: { id: ids.application },
      data: { status: "SUBMITTED", decisionReason: null },
    })
    const before = await submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { status: true, decisionReason: true },
    })

    await expect(submissionDb.$transaction(async (tx) => {
      await tx.loanApplication.update({
        where: { id: ids.application },
        data: { status: "CANCELLED", decisionReason: "Cancelled by staff" },
      })
      await tx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          userId: `missing-user-${token}`,
          action: "APPLICATION_CANCELLED",
          entity: "LoanApplication",
          entityId: ids.application,
        },
      })
    })).rejects.toThrow()

    await expect(submissionDb.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { status: true, decisionReason: true },
    })).resolves.toEqual(before)
  })

  it("rolls back an AVS result when its mandatory audit insert fails", async () => {
    await expect(submissionDb.$transaction(async (tx) => {
      await tx.avsCheck.create({
        data: {
          id: ids.avs,
          tenantId: ids.tenant,
          clientId: ids.client,
          applicationId: ids.application,
          subjectFingerprint: "a".repeat(64),
          provider: "integration-probe",
          accountHolder: "Synthetic Snapshot",
          bankName: "Test Bank",
          branchCode: "000000",
          accountNumber: "0000000000",
          accountType: "CHEQUE",
          passed: true,
          checks: {},
        },
      })
      await tx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          userId: `missing-user-${token}`,
          action: "AVS_CHECK_RUN",
          entity: "AvsCheck",
          entityId: ids.avs,
        },
      })
    })).rejects.toThrow()

    await expect(submissionDb.avsCheck.findUnique({
      where: { id: ids.avs },
    })).resolves.toBeNull()
  })

  it("rolls back a credit-policy mutation when its mandatory audit insert fails", async () => {
    await expect(submissionDb.$transaction(async (tx) => {
      await lockAffordabilityTenantPolicy(tx, { tenantId: ids.tenant })
      await tx.tenantConfig.upsert({
        where: { tenantId: ids.tenant },
        update: { bureauMinScore: 620, bureauBlockAdverse: true, ndiBufferPct: 125 },
        create: {
          tenantId: ids.tenant,
          bureauMinScore: 620,
          bureauBlockAdverse: true,
          ndiBufferPct: 125,
        },
      })
      await tx.auditLog.create({
        data: {
          tenantId: ids.tenant,
          userId: `missing-user-${token}`,
          action: "CREDIT_POLICY_UPDATED",
          entity: "TenantConfig",
          entityId: ids.tenant,
        },
      })
    })).rejects.toThrow()

    await expect(submissionDb.tenantConfig.findUnique({
      where: { tenantId: ids.tenant },
    })).resolves.toBeNull()
  })

  it("rolls back the loan, schedule, policy, commission, and status when the disbursement audit fails", async () => {
    // Built on the PASQ v3 fixture: the hand-built application above cannot
    // reach APPROVED under the PASQ v3 guards.
    const scenario = await createApprovedPasqV3Application("submission-lock")
    const loanId = `loan_rollback_${token}`
    const policyId = `policy_rollback_${token}`
    const referralEventId = `referral_event_rollback_${token}`

    type Tx = Parameters<Parameters<typeof submissionDb.$transaction>[0]>[0]
    const writeBeforeAudit = async (tx: Tx) => {
      await writePasqV3Disbursement(tx, scenario, { loanId, policyId })
      await tx.referralEvent.create({
        data: {
          id: referralEventId,
          tenantId: scenario.tenantId,
          eventType: "CONVERTED",
          source: "PORTAL",
          amountCents: 500_000,
          commissionCents: 10_000,
          commissionStatus: "PENDING",
          metadata: { loanId, applicationId: scenario.applicationId },
        },
      })
    }

    // Precondition: every write before the audit insert succeeds on its own, so
    // the rejection below can only come from the audit row, not an earlier write.
    class WritesReachedAudit extends Error {}
    await expect(submissionDb.$transaction(async (tx) => {
      await writeBeforeAudit(tx)
      throw new WritesReachedAudit()
    })).rejects.toBeInstanceOf(WritesReachedAudit)

    await expect(submissionDb.$transaction(async (tx) => {
      await writeBeforeAudit(tx)
      await tx.auditLog.create({
        data: {
          tenantId: scenario.tenantId,
          userId: `missing-user-${token}`,
          action: "LOAN_DISBURSED",
          entity: "LoanApplication",
          entityId: scenario.applicationId,
        },
      })
    })).rejects.toThrow()

    const [loan, scheduleCount, policy, commission, application] = await Promise.all([
      submissionDb.loan.findUnique({ where: { id: loanId } }),
      submissionDb.repaymentSchedule.count({ where: { loanId } }),
      submissionDb.insurancePolicy.findUnique({ where: { id: policyId } }),
      submissionDb.referralEvent.findUnique({ where: { id: referralEventId } }),
      submissionDb.loanApplication.findUniqueOrThrow({
        where: { id: scenario.applicationId },
        select: { status: true, disbursedAt: true },
      }),
    ])
    expect({ loan, scheduleCount, policy, commission, application }).toEqual({
      loan: null,
      scheduleCount: 0,
      policy: null,
      commission: null,
      application: { status: "APPROVED", disbursedAt: null },
    })
  })

  it("serializes a payout KYC read against concurrent post-approval revocation", async () => {
    await submissionDb.client.update({
      where: { id: ids.client },
      data: { kycStatus: "VERIFIED" },
    })

    let announcePayoutLocked!: () => void
    const payoutLocked = new Promise<void>((resolve) => { announcePayoutLocked = resolve })
    let releasePayout!: () => void
    const release = new Promise<void>((resolve) => { releasePayout = resolve })

    const payout = submissionDb.$transaction(async (tx) => {
      await lockAffordabilityClientEvidence(tx, {
        tenantId: ids.tenant,
        clientId: ids.client,
      })
      const client = await tx.client.findUniqueOrThrow({
        where: { id: ids.client },
        select: { kycStatus: true },
      })
      expect(client.kycStatus).toBe("VERIFIED")
      announcePayoutLocked()
      await release

      // The writer uses the same lock protocol, so the payout transaction's
      // current-KYC decision cannot be invalidated before this commit point.
      const stillCurrent = await tx.client.findUniqueOrThrow({
        where: { id: ids.client },
        select: { kycStatus: true },
      })
      expect(stillCurrent.kycStatus).toBe("VERIFIED")
    })

    await payoutLocked
    let revocationFinished = false
    const revocation = clientWriter.$transaction(async (tx) => {
      await lockAffordabilityClientEvidence(tx, {
        tenantId: ids.tenant,
        clientId: ids.client,
      })
      await tx.client.update({
        where: { id: ids.client },
        data: {
          kycStatus: "FAILED",
          kycVerifiedAt: null,
          kycVerificationMethod: null,
        },
      })
      revocationFinished = true
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(revocationFinished).toBe(false)

    releasePayout()
    await Promise.all([payout, revocation])
    await expect(submissionDb.client.findUniqueOrThrow({
      where: { id: ids.client },
      select: { kycStatus: true },
    })).resolves.toEqual({ kycStatus: "FAILED" })
  })
})
