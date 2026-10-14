/**
 * Real-Postgres proof for the KYC override storage boundary.
 * RUN_KYC_OVERRIDE_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/kyc/override-policy.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { Prisma, PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"

const RUN = process.env.RUN_KYC_OVERRIDE_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const root = randomUUID().replaceAll("-", "")

type Fixture = Awaited<ReturnType<typeof fixture>>

async function fixture(label: string, similarity: number, samePerson: "different" | "uncertain") {
  const suffix = `${label}_${root}`
  const tenantId = `tenant_${suffix}`
  const clientId = `client_${suffix}`
  const requesterId = `requester_${suffix}`
  const approverId = `approver_${suffix}`
  const selfieId = `selfie_${suffix}`
  const selfieSha = similarity.toString().replace(".", "").padEnd(64, "a").slice(0, 64)
  const subject = {
    id: clientId,
    idNumber: `ID-${suffix}`,
    firstName: "Synthetic",
    lastName: "Override",
    dateOfBirth: new Date("1990-01-02T00:00:00.000Z"),
  }
  await db.tenant.create({ data: { id: tenantId, slug: `slug-${suffix}`, name: `Tenant ${label}` } })
  await db.user.createMany({ data: [
    { id: requesterId, tenantId, email: `requester-${suffix}@test.invalid`, password: "synthetic", role: "ADMIN", totpEnabled: true, lastTotpCounter: 1 },
    { id: approverId, tenantId, email: `approver-${suffix}@test.invalid`, password: "synthetic", role: "ADMIN", totpEnabled: true, lastTotpCounter: 2 },
  ] })
  await db.client.create({ data: {
    ...subject, tenantId, reference: `REF-${suffix}`, email: `client-${suffix}@test.invalid`, phone: "+27820000001",
  } })
  await db.clientDocument.createMany({ data: ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"].map((docType, index) => ({
    id: `core_${index}_${suffix}`, tenantId, clientId,
    docType: docType as "ID_COPY" | "PROOF_OF_ADDRESS" | "PAYSLIP" | "BANK_STATEMENT",
    fileUrl: "", fileName: `${docType}.pdf`, verified: true, verifiedAt: new Date(),
  })) })
  await db.clientDocument.create({ data: {
    id: selfieId, tenantId, clientId, docType: "SELFIE", fileUrl: "", fileName: "synthetic-selfie.jpg",
    contentSha256: selfieSha, extractionStatus: "failed", validationMismatch: true,
    biometricResult: {
      biometricFailureReason: "match_score_below_threshold",
      faceModel: { similarity },
      faceVerdict: { samePerson },
    },
  } })
  return { tenantId, clientId, requesterId, approverId, selfieId, selfieSha, subject }
}

function exceptionData(
  f: Fixture,
  approvedAt: Date,
  policyEvidence: { approvedWithTotp?: boolean; overrideRequestId?: string } = { approvedWithTotp: true },
) {
  return {
    kind: "KYC_MANUAL_EXCEPTION",
    version: "manual-kyc-exception-v1",
    clientId: f.clientId,
    documentId: f.selfieId,
    documentSha256: f.selfieSha,
    subjectFingerprint: biometricSubjectFingerprint(f.subject),
    biometricFailureReason: "match_score_below_threshold",
    reason: "Synthetic senior review reason for integration proof.",
    supportingEvidence: "Synthetic supporting evidence for integration proof.",
    approvedAt: approvedAt.toISOString(),
    approvedById: f.approverId,
    approvedByEmail: `approver-${f.clientId}@test.invalid`,
    ...policyEvidence,
  }
}

async function insertException(
  f: Fixture,
  approvedAt = new Date(),
  policyEvidence?: { approvedWithTotp?: boolean; overrideRequestId?: string },
  client: PrismaClient | Prisma.TransactionClient = db,
) {
  return client.complianceRecord.create({ data: {
    tenantId: f.tenantId, type: "KYC_EXCEPTION", referenceId: f.clientId,
    idempotencyKey: `exception:${f.selfieId}:${randomUUID()}`,
    status: "COMPLETED", completedAt: approvedAt, data: exceptionData(f, approvedAt, policyEvidence),
  } })
}

suite("KYC override database enforcement", () => {
  afterAll(async () => db.$disconnect())

  it.each([
    ["similarity below floor", 0.29, "uncertain"],
    ["VLM different verdict", 0.33, "different"],
  ] as const)("refuses a direct clear-mismatch exception: %s", async (label, similarity, verdict) => {
    const f = await fixture(`clear_${similarity}_${verdict}`, similarity, verdict)
    await expect(insertException(f)).rejects.toThrow("clear face mismatch cannot be overridden")
  })

  it("never projects a clear-mismatch exception even if the write trigger is bypassed", async () => {
    const f = await fixture("projection", 0.29, "uncertain")
    await db.$executeRawUnsafe('ALTER TABLE "ComplianceRecord" DISABLE TRIGGER "ComplianceRecord_guard_clear_mismatch_kyc_exception"')
    try {
      await insertException(f)
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "ComplianceRecord" ENABLE TRIGGER "ComplianceRecord_guard_clear_mismatch_kyc_exception"')
    }
    const rows = await db.$queryRaw<Array<{ ok: boolean }>>`
      SELECT "subject_has_composite_kyc"(
        ${f.tenantId}, ${f.clientId}, ${f.subject.idNumber}, ${f.subject.firstName},
        ${f.subject.lastName}, ${f.subject.dateOfBirth}::timestamp without time zone
      ) AS ok`
    expect(rows[0]?.ok).toBe(false)
  })

  it.each([
    ["future", "clock_timestamp() + interval '1 year'", "clock_timestamp() + interval '1 year 7 days'"],
    ["infinite", "'infinity'::timestamp", "'infinity'::timestamp"],
  ] as const)("refuses %s request timestamps", async (label, requestedAtSql, expiresAtSql) => {
    const f = await fixture(`timestamp_${label}`, 0.33, "uncertain")
    await db.tenantConfig.create({ data: {
      tenantId: f.tenantId,
      kycOverrideEnabled: true,
      kycOverrideSecondApprover: true,
    } })
    await expect(db.$executeRawUnsafe(`
      INSERT INTO "KycOverrideRequest" (
        "id", "tenantId", "clientId", "selfieDocumentId", "kind", "payload",
        "requestedById", "requestedWithTotp", "requestedAt", "status", "expiresAt"
      ) VALUES (
        'request_${label}_${root}', '${f.tenantId}', '${f.clientId}', '${f.selfieId}',
        'EXCEPTION', '{"reason":"Synthetic senior review reason for integration proof.","supportingEvidence":"Synthetic supporting evidence for integration proof."}'::jsonb,
        '${f.requesterId}', true, ${requestedAtSql}, 'PENDING', ${expiresAtSql}
      )
    `)).rejects.toThrow("timestamps must be finite and requestedAt cannot be in the future")
  })

  it("accepts a borderline exception and permits VERIFIED projection", async () => {
    const f = await fixture("borderline", 0.33, "uncertain")
    const approvedAt = new Date()
    await insertException(f, approvedAt)
    const client = await db.client.update({
      where: { id: f.clientId },
      data: { kycStatus: "VERIFIED", kycVerifiedAt: approvedAt, kycVerifiedById: f.approverId, kycVerificationMethod: "PHYSICAL" },
      select: { kycStatus: true },
    })
    expect(client.kycStatus).toBe("VERIFIED")
  })

  it.each(["KYC_MANUAL_EXCEPTION", "KYC_IN_PERSON_VERIFICATION"] as const)(
    "refuses a direct completed %s record while overrides are disabled",
    async (kind) => {
      const f = await fixture(`disabled_${kind}`, 0.33, "uncertain")
      await db.tenantConfig.create({ data: {
        tenantId: f.tenantId,
        kycOverrideEnabled: false,
        requireStaffTotp: false,
      } })
      await expect(db.complianceRecord.create({ data: {
        tenantId: f.tenantId,
        type: "KYC_EXCEPTION",
        referenceId: f.clientId,
        idempotencyKey: `policy-disabled:${kind}:${randomUUID()}`,
        status: "COMPLETED",
        completedAt: new Date(),
        data: { kind, approvedById: f.approverId },
      } })).rejects.toThrow("KYC overrides are disabled")
    },
  )

  it("refuses a completed override by an actor below the lender minimum role", async () => {
    const f = await fixture("actor_role", 0.33, "uncertain")
    await db.user.update({ where: { id: f.approverId }, data: { role: "BRANCH_MANAGER" } })
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, requireStaffTotp: false } })
    await expect(insertException(f, new Date(), { approvedWithTotp: false })).rejects.toThrow(
      "approver is below the lender minimum role",
    )
  })

  it("refuses a completed override without the lender-required durable TOTP assertion", async () => {
    const f = await fixture("totp", 0.33, "uncertain")
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, requireStaffTotp: true } })
    await expect(insertException(f, new Date(), { approvedWithTotp: false })).rejects.toThrow(
      "requires a durable TOTP assertion",
    )
  })

  it("requires and accepts a matching approved request when dual control is enabled", async () => {
    const f = await fixture("dual_policy", 0.33, "uncertain")
    await db.tenantConfig.create({ data: {
      tenantId: f.tenantId,
      requireStaffTotp: true,
      kycOverrideSecondApprover: true,
    } })
    await expect(insertException(f)).rejects.toThrow("requires a matching approved request")

    const requestedAt = new Date()
    const request = await db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId,
      clientId: f.clientId,
      selfieDocumentId: f.selfieId,
      kind: "EXCEPTION",
      payload: {
        reason: "Synthetic senior review reason for integration proof.",
        supportingEvidence: "Synthetic supporting evidence for integration proof.",
      },
      requestedById: f.requesterId,
      requestedWithTotp: true,
      requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
    } })
    await expect(db.$transaction(async (tx) => {
      await tx.kycOverrideRequest.update({ where: { id: request.id }, data: {
        status: "APPROVED",
        decidedById: f.approverId,
        decidedAt: new Date(),
        decisionNote: "Synthetic dual-control approval reason.",
      } })
      const record = await insertException(f, new Date(), {
        approvedWithTotp: true,
        overrideRequestId: request.id,
      }, tx)
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return record
    })).resolves.toMatchObject({ tenantId: f.tenantId })
    await expect(insertException(f, new Date(), {
      approvedWithTotp: true,
      overrideRequestId: request.id,
    })).rejects.toThrow("Unique constraint failed")
  })

  it("refuses a request inserted directly as already approved", async () => {
    const f = await fixture("forged_approved", 0.33, "uncertain")
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, kycOverrideSecondApprover: true } })
    const requestedAt = new Date()
    await expect(db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId, clientId: f.clientId, selfieDocumentId: f.selfieId,
      kind: "EXCEPTION", payload: {}, requestedById: f.requesterId, requestedWithTotp: true,
      requestedAt, expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
      status: "APPROVED", decidedById: f.approverId, decidedAt: requestedAt,
      decisionNote: "Forged direct approval must be rejected.",
    } })).rejects.toThrow("must be inserted as PENDING")
  })

  it("refuses a pending request from an ineligible requester", async () => {
    const f = await fixture("junior_requester", 0.33, "uncertain")
    await db.user.update({ where: { id: f.requesterId }, data: { role: "READONLY" } })
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, kycOverrideSecondApprover: true } })
    const requestedAt = new Date()
    await expect(db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId, clientId: f.clientId, selfieDocumentId: f.selfieId,
      kind: "EXCEPTION", payload: {}, requestedById: f.requesterId, requestedWithTotp: true,
      requestedAt, expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
    } })).rejects.toThrow("requester is not an active eligible senior")
  })

  it("binds an approved request to its immutable payload", async () => {
    const f = await fixture("payload_binding", 0.33, "uncertain")
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, kycOverrideSecondApprover: true } })
    const requestedAt = new Date()
    const request = await db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId, clientId: f.clientId, selfieDocumentId: f.selfieId,
      kind: "EXCEPTION",
      payload: { reason: "Approved request reason is deliberately different.", supportingEvidence: "Synthetic supporting evidence for integration proof." },
      requestedById: f.requesterId, requestedWithTotp: true, requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
    } })
    await expect(db.$transaction(async (tx) => {
      await tx.kycOverrideRequest.update({ where: { id: request.id }, data: {
        status: "APPROVED", decidedById: f.approverId, decidedAt: new Date(),
        decisionNote: "Synthetic approval decision reason.",
      } })
      const record = await insertException(f, new Date(), {
        approvedWithTotp: true, overrideRequestId: request.id,
      }, tx)
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return record
    })).rejects.toThrow("must grant matching evidence in the same transaction")
  })

  it("refuses an approval committed without its matching grant", async () => {
    const f = await fixture("approve_only", 0.33, "uncertain")
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, kycOverrideSecondApprover: true } })
    const requestedAt = new Date()
    const request = await db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId, clientId: f.clientId, selfieDocumentId: f.selfieId,
      kind: "EXCEPTION", payload: {
        reason: "Synthetic senior review reason for integration proof.",
        supportingEvidence: "Synthetic supporting evidence for integration proof.",
      },
      requestedById: f.requesterId, requestedWithTotp: true, requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
    } })
    await expect(db.kycOverrideRequest.update({ where: { id: request.id }, data: {
      status: "APPROVED", decidedById: f.approverId, decidedAt: new Date(),
      decisionNote: "Approval without a grant must roll back.",
    } })).rejects.toThrow("must grant matching evidence in the same transaction")
  })

  it("refuses requester = approver", async () => {
    const f = await fixture("self", 0.33, "uncertain")
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, kycOverrideSecondApprover: true } })
    const requestedAt = new Date()
    const request = await db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId, clientId: f.clientId, selfieDocumentId: f.selfieId,
      kind: "EXCEPTION", payload: {}, requestedById: f.requesterId, requestedWithTotp: true, requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
    } })
    await expect(db.kycOverrideRequest.update({ where: { id: request.id }, data: {
      status: "APPROVED", decidedById: f.requesterId, decidedAt: requestedAt,
      decisionNote: "Synthetic approval reason.",
    } })).rejects.toThrow("KycOverrideRequest_different_decider_check")
  })

  it("refuses approval after expiry", async () => {
    const f = await fixture("expired", 0.33, "uncertain")
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, kycOverrideSecondApprover: true } })
    const requestedAt = new Date(Date.now() - 8 * 86400000)
    const request = await db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId, clientId: f.clientId, selfieDocumentId: f.selfieId,
      kind: "EXCEPTION", payload: {}, requestedById: f.requesterId, requestedWithTotp: true, requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
    } })
    await expect(db.kycOverrideRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", decidedById: f.approverId, decidedAt: new Date(), decisionNote: "Synthetic approval reason." },
    })).rejects.toThrow("expired KYC override request cannot be approved")
  })

  it("makes a decided request immutable and non-deletable", async () => {
    const f = await fixture("immutable", 0.33, "uncertain")
    await db.tenantConfig.create({ data: { tenantId: f.tenantId, kycOverrideSecondApprover: true } })
    const requestedAt = new Date()
    const request = await db.kycOverrideRequest.create({ data: {
      tenantId: f.tenantId, clientId: f.clientId, selfieDocumentId: f.selfieId,
      kind: "EXCEPTION", payload: {}, requestedById: f.requesterId, requestedWithTotp: true, requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 86400000),
    } })
    await db.kycOverrideRequest.update({ where: { id: request.id }, data: {
      status: "DECLINED", decidedById: f.approverId, decidedAt: new Date(), decisionNote: "Synthetic decline reason.",
    } })
    await expect(db.kycOverrideRequest.update({ where: { id: request.id }, data: { decisionNote: "Changed reason is forbidden." } })).rejects.toThrow("decided KYC override requests are immutable")
    await expect(db.kycOverrideRequest.delete({ where: { id: request.id } })).rejects.toThrow("KYC override requests cannot be deleted")
  })

  it("refuses LOAN_ADMIN as the lender minimum override role", async () => {
    const f = await fixture("role", 0.33, "uncertain")
    await expect(db.tenantConfig.upsert({
      where: { tenantId: f.tenantId },
      create: { tenantId: f.tenantId, kycOverrideMinRole: "LOAN_ADMIN" },
      update: { kycOverrideMinRole: "LOAN_ADMIN" },
    })).rejects.toThrow("TenantConfig_kycOverrideMinRole_check")
  })
})
