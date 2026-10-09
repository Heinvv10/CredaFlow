/**
 * Database proof for the manual KYC exception projection guard.
 *
 * Run against a throwaway fully migrated PostgreSQL database:
 *
 *   RUN_KYC_EXCEPTION_PROJECTION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/manual-exception-projection.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
} from "@/lib/kyc/manual-exception"

const RUN = process.env.RUN_KYC_EXCEPTION_PROJECTION_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "")

suite("manual KYC exception database projection", () => {
  const tenantId = `tenant_kyc_exception_${token}`
  const clientId = `client_kyc_exception_${token}`
  const reviewerId = `reviewer_kyc_exception_${token}`
  const firstSelfieId = `selfie_kyc_exception_1_${token}`
  const secondSelfieId = `selfie_kyc_exception_2_${token}`
  const firstSelfieSha = "a".repeat(64)
  const secondSelfieSha = "b".repeat(64)
  const firstApprovedAt = new Date("2026-07-23T19:00:00.000Z")
  const secondApprovedAt = new Date("2026-07-23T19:05:00.000Z")
  let secondExceptionId = ""
  let secondExceptionData: Record<string, unknown> = {}
  let exceptionSequence = 0
  let latestValidApprovedAt = secondApprovedAt
  const subject = {
    id: clientId,
    idNumber: `KYC-${token}`,
    firstName: "Synthetic",
    lastName: "Exception",
    dateOfBirth: new Date("1991-02-03T00:00:00.000Z"),
  }
  const subjectFingerprint = biometricSubjectFingerprint(subject)

  function exceptionData(args: {
    documentId: string
    documentSha256: string
    approvedAt: Date
  }) {
    return {
      kind: MANUAL_KYC_EXCEPTION_KIND,
      version: MANUAL_KYC_EXCEPTION_VERSION,
      clientId,
      documentId: args.documentId,
      documentSha256: args.documentSha256,
      subjectFingerprint,
      biometricFailureReason: "face_not_detected",
      reason:
        "Synthetic integration exception after a controlled failed biometric attempt.",
      supportingEvidence:
        "Four verified synthetic core documents and the exact failed selfie were reviewed.",
      approvedAt: args.approvedAt.toISOString(),
      approvedById: reviewerId,
      approvedByEmail: "reviewer@test.invalid",
    }
  }

  async function createSupersedingException(
    overrides: Record<string, unknown>,
    evidenceApprovedAt: (storedAt: Date) => string = (storedAt) =>
      storedAt.toISOString(),
  ) {
    exceptionSequence += 1
    const approvedAt = new Date(
      secondApprovedAt.getTime() + exceptionSequence * 1_000,
    )
    const data = {
      ...exceptionData({
        documentId: secondSelfieId,
        documentSha256: secondSelfieSha,
        approvedAt,
      }),
      ...overrides,
      approvedAt: evidenceApprovedAt(approvedAt),
    }
    await db.complianceRecord.create({
      data: {
        tenantId,
        type: "KYC_EXCEPTION",
        referenceId: clientId,
        idempotencyKey: `kyc-exception-normalization:${clientId}:${randomUUID()}`,
        status: "COMPLETED",
        completedAt: approvedAt,
        data,
      },
    })
    return approvedAt
  }

  async function expectProjectionRejected(
    overrides: Record<string, unknown>,
  ) {
    const approvedAt = await createSupersedingException(overrides)
    await expect(
      db.client.update({
        where: { id: clientId },
        data: {
          kycStatus: "VERIFIED",
          kycVerifiedAt: approvedAt,
          kycVerifiedById: reviewerId,
          kycVerificationMethod: "PHYSICAL",
        },
      }),
    ).rejects.toThrow(
      "Client KYC cannot be VERIFIED without current composite evidence",
    )
  }

  beforeAll(async () => {
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: `kyc-exception-${token}`,
        name: "KYC exception integration",
      },
    })
    await db.client.create({
      data: {
        ...subject,
        tenantId,
        reference: `CLI-KYC-EXCEPTION-${token}`,
        email: `kyc-exception-${token}@test.invalid`,
        phone: "+27820000077",
      },
    })
    await db.clientDocument.createMany({
      data: [
        "ID_COPY",
        "PROOF_OF_ADDRESS",
        "PAYSLIP",
        "BANK_STATEMENT",
      ].map((docType, index) => ({
        id: `kyc_exception_core_${index}_${token}`,
        tenantId,
        clientId,
        docType: docType as
          | "ID_COPY"
          | "PROOF_OF_ADDRESS"
          | "PAYSLIP"
          | "BANK_STATEMENT",
        fileUrl: "",
        fileName: `${docType.toLowerCase()}.pdf`,
        verified: true,
        verifiedAt: firstApprovedAt,
      })),
    })
    await db.clientDocument.create({
      data: {
        id: firstSelfieId,
        tenantId,
        clientId,
        docType: "SELFIE",
        fileUrl: "",
        fileName: "failed-selfie-1.jpg",
        contentSha256: firstSelfieSha,
        extractionStatus: "failed",
        extractionError: "Biometric verification did not run",
        validationMismatch: true,
        validationScore: 0,
        biometricResult: {
          subjectFingerprint,
          biometricFailureReason: "face_not_detected",
        },
      },
    })
    await db.complianceRecord.create({
      data: {
        tenantId,
        type: "KYC_EXCEPTION",
        referenceId: clientId,
        idempotencyKey: `kyc-exception:${clientId}:${firstSelfieId}:${firstSelfieSha}`,
        status: "COMPLETED",
        completedAt: firstApprovedAt,
        data: exceptionData({
          documentId: firstSelfieId,
          documentSha256: firstSelfieSha,
          approvedAt: firstApprovedAt,
        }),
      },
    })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("allows VERIFIED only through the exact bound exception path", async () => {
    const updated = await db.client.update({
      where: { id: clientId },
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: firstApprovedAt,
        kycVerifiedById: reviewerId,
        kycVerificationMethod: "PHYSICAL",
      },
      select: {
        kycStatus: true,
        kycVerificationMethod: true,
      },
    })

    expect(updated).toEqual({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "PHYSICAL",
    })
  })

  it("revokes the exception projection when a new selfie becomes authoritative", async () => {
    await db.clientDocument.create({
      data: {
        id: secondSelfieId,
        tenantId,
        clientId,
        docType: "SELFIE",
        fileUrl: "",
        fileName: "failed-selfie-2.jpg",
        contentSha256: secondSelfieSha,
        extractionStatus: "failed",
        extractionError: "Biometric verification did not run",
        validationMismatch: true,
        validationScore: 0,
        biometricResult: {
          subjectFingerprint,
          biometricFailureReason: "face_not_detected",
        },
      },
    })

    const client = await db.client.findUniqueOrThrow({
      where: { id: clientId },
      select: {
        kycStatus: true,
        kycVerifiedAt: true,
        kycVerifiedById: true,
        kycVerificationMethod: true,
      },
    })
    expect(client).toEqual({
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })
  })

  it("allows a new record to supersede stale exception evidence", async () => {
    const exception = await db.complianceRecord.create({
      data: {
        tenantId,
        type: "KYC_EXCEPTION",
        referenceId: clientId,
        idempotencyKey: `kyc-exception:${clientId}:${secondSelfieId}:${secondSelfieSha}`,
        status: "COMPLETED",
        completedAt: secondApprovedAt,
        data: exceptionData({
          documentId: secondSelfieId,
          documentSha256: secondSelfieSha,
          approvedAt: secondApprovedAt,
        }),
      },
      select: { id: true, data: true },
    })
    secondExceptionId = exception.id
    secondExceptionData = exception.data as Record<string, unknown>
    await db.client.update({
      where: { id: clientId },
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: secondApprovedAt,
        kycVerifiedById: reviewerId,
        kycVerificationMethod: "PHYSICAL",
      },
    })
  })

  it("rejects valid-to-valid edits to completed exception evidence", async () => {
    await expect(
      db.complianceRecord.update({
        where: { id: secondExceptionId },
        data: {
          data: {
            ...secondExceptionData,
            reason:
              "A different valid reason must not rewrite completed evidence.",
          },
        },
      }),
    ).rejects.toThrow(
      "Completed KYC exception evidence is immutable; create a superseding record instead",
    )

    const [client, exception] = await Promise.all([
      db.client.findUniqueOrThrow({
        where: { id: clientId },
        select: { kycStatus: true },
      }),
      db.complianceRecord.findUniqueOrThrow({
        where: { id: secondExceptionId },
        select: { data: true },
      }),
    ])
    expect(client.kycStatus).toBe("VERIFIED")
    expect(exception.data).toEqual(secondExceptionData)
  })

  it("rejects deletion of completed exception evidence", async () => {
    await expect(
      db.complianceRecord.delete({
        where: { id: secondExceptionId },
      }),
    ).rejects.toThrow(
      "Completed KYC exception evidence is immutable; create a superseding record instead",
    )

    const [client, exceptionCount] = await Promise.all([
      db.client.findUniqueOrThrow({
        where: { id: clientId },
        select: { kycStatus: true },
      }),
      db.complianceRecord.count({
        where: { id: secondExceptionId },
      }),
    ])
    expect(client.kycStatus).toBe("VERIFIED")
    expect(exceptionCount).toBe(1)
  })

  it.each([
    ["tabs in reason", { reason: "\t".repeat(20) }],
    ["newlines in supporting evidence", {
      supportingEvidence: "\n".repeat(20),
    }],
    ["non-breaking spaces in reason", { reason: "\u00a0".repeat(20) }],
    ["Unicode em spaces in reason", { reason: "\u2003".repeat(20) }],
    ["tabs in reviewer id", { approvedById: "\t".repeat(20) }],
    ["newlines in reviewer email", { approvedByEmail: "\n".repeat(20) }],
  ] as const)("rejects %s at the database projection", async (_label, data) => {
    await expectProjectionRejected(data)
  })

  it("counts astral characters as Unicode code points in the database", async () => {
    await expectProjectionRejected({ reason: "😀".repeat(10) })

    const approvedAt = await createSupersedingException({
      reason: "😀".repeat(20),
      supportingEvidence: "🧾".repeat(20),
    })
    latestValidApprovedAt = approvedAt
    const client = await db.client.update({
      where: { id: clientId },
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: approvedAt,
        kycVerifiedById: reviewerId,
        kycVerificationMethod: "PHYSICAL",
      },
      select: {
        kycStatus: true,
        kycVerificationMethod: true,
      },
    })
    expect(client).toEqual({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "PHYSICAL",
    })
  })

  it("remains valid in a non-UTC PostgreSQL session", async () => {
    await db.client.update({
      where: { id: clientId },
      data: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    })

    const client = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SET LOCAL TIME ZONE 'Africa/Johannesburg'",
      )
      return tx.client.update({
        where: { id: clientId },
        data: {
          kycStatus: "VERIFIED",
          kycVerifiedAt: latestValidApprovedAt,
          kycVerifiedById: reviewerId,
          kycVerificationMethod: "PHYSICAL",
        },
        select: {
          kycStatus: true,
          kycVerificationMethod: true,
        },
      })
    })
    expect(client).toEqual({
      kycStatus: "VERIFIED",
      kycVerificationMethod: "PHYSICAL",
    })
  })

  it("rejects a session-timezone-shifted approved timestamp", async () => {
    const storedAt = await createSupersedingException(
      {},
      (approvedAt) =>
        new Date(approvedAt.getTime() + 2 * 60 * 60 * 1_000).toISOString(),
    )

    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL TIME ZONE 'Africa/Johannesburg'",
        )
        return tx.client.update({
          where: { id: clientId },
          data: {
            kycStatus: "VERIFIED",
            kycVerifiedAt: storedAt,
            kycVerifiedById: reviewerId,
            kycVerificationMethod: "PHYSICAL",
          },
        })
      }),
    ).rejects.toThrow(
      "Client KYC cannot be VERIFIED without current composite evidence",
    )
  })
})
