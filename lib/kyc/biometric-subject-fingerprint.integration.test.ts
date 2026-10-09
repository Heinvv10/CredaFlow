/**
 * Cross-runtime proof for the biometric subject fingerprint and database KYC
 * projection trigger.
 *
 * Run against a throwaway fully migrated PostgreSQL database:
 *
 *   RUN_BIOMETRIC_FINGERPRINT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/biometric-subject-fingerprint.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import {
  biometricSubjectFingerprint,
  type BiometricSubjectClient,
} from "@/lib/kyc/biometric-evidence"

const RUN = process.env.RUN_BIOMETRIC_FINGERPRINT_IT === "1"
const suite = RUN ? describe : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "")

const parityVectors: BiometricSubjectClient[] = [
  {
    id: `client_ascii_${token}`,
    idNumber: "9001015009087",
    firstName: "Synthetic",
    lastName: "Customer",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  },
  {
    id: `client_sharp_s_${token}`,
    idNumber: "9001015009087",
    firstName: "Straße",
    lastName: "Mkhize",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  },
  {
    id: `client_accented_${token}`,
    idNumber: "ID-İ- 42",
    firstName: "İpek",
    lastName: "D’Ávila-Ndlovu",
    dateOfBirth: new Date("1988-12-03T00:00:00.000Z"),
  },
  {
    id: `client_combining_${token}`,
    idNumber: "ID-03",
    firstName: "Jose\u0301",
    lastName: "N\u0303dlovu",
    dateOfBirth: null,
  },
]

suite("biometric subject fingerprint parity", () => {
  const tenantId = `tenant_fingerprint_${token}`
  const unicodeSubject: BiometricSubjectClient = {
    id: `client_fingerprint_verified_${token}`,
    idNumber: `UNICODE-${token}`,
    firstName: "Straße",
    lastName: "D’Ávila-Ndlovu",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  }

  beforeAll(async () => {
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: `fingerprint-${token}`,
        name: "Biometric fingerprint integration",
      },
    })
    await db.client.create({
      data: {
        ...unicodeSubject,
        tenantId,
        reference: `CLI-FINGERPRINT-${token}`,
        email: `fingerprint-${token}@test.invalid`,
        phone: "+27820000041",
      },
    })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it.each(parityVectors)(
    "matches JavaScript and PostgreSQL for $firstName $lastName",
    async (subject) => {
      const [row] = await db.$queryRaw<Array<{ fingerprint: string }>>`
        SELECT "biometric_subject_fingerprint"(
          ${subject.id},
          ${subject.idNumber},
          ${subject.firstName},
          ${subject.lastName},
          CAST(${subject.dateOfBirth} AS TIMESTAMP(3))
        ) AS fingerprint
      `

      expect(row.fingerprint).toBe(biometricSubjectFingerprint(subject))
    },
  )

  it("allows valid Unicode-bound composite evidence to project VERIFIED", async () => {
    const verifiedAt = new Date("2026-07-23T08:00:00.000Z")
    await db.clientDocument.createMany({
      data: [
        "ID_COPY",
        "PROOF_OF_ADDRESS",
        "PAYSLIP",
        "BANK_STATEMENT",
      ].map((docType, index) => ({
        id: `fingerprint_core_${index}_${token}`,
        tenantId,
        clientId: unicodeSubject.id,
        docType: docType as
          | "ID_COPY"
          | "PROOF_OF_ADDRESS"
          | "PAYSLIP"
          | "BANK_STATEMENT",
        fileUrl: "",
        fileName: `${docType.toLowerCase()}.pdf`,
        verified: true,
        verifiedAt,
      })),
    })
    await db.clientDocument.create({
      data: {
        id: `fingerprint_selfie_${token}`,
        tenantId,
        clientId: unicodeSubject.id,
        docType: "SELFIE",
        fileUrl: "",
        fileName: "selfie.jpg",
        verified: true,
        verifiedAt,
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
        biometricVerifiedAt: verifiedAt,
        biometricResult: {
          ok: true,
          verified: true,
          matchScore: 98,
          livenessScore: 97,
          subjectFingerprint: biometricSubjectFingerprint(unicodeSubject),
        },
      },
    })

    const updated = await db.client.update({
      where: { id: unicodeSubject.id },
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: verifiedAt,
        kycVerificationMethod: "SMILE_IDENTITY",
      },
      select: { kycStatus: true },
    })

    expect(updated.kycStatus).toBe("VERIFIED")
  })
})
