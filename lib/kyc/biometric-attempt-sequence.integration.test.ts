/**
 * Run against a throwaway fully migrated PostgreSQL database:
 *
 *   RUN_BIOMETRIC_SEQUENCE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/biometric-attempt-sequence.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { latestSelfieOrder } from "./document-state"

const RUN = process.env.RUN_BIOMETRIC_SEQUENCE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_biometric_sequence_${token}`
const clientId = `client_biometric_sequence_${token}`
const tiedAt = new Date("2026-07-23T01:00:00.000Z")

suite("biometric attempt sequence", () => {
  beforeAll(async () => {
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: `biometric-sequence-${token}`,
        name: "Biometric sequence integration test",
      },
    })
    await db.client.create({
      data: {
        id: clientId,
        tenantId,
        reference: `CLI-BIO-${token}`,
        idNumber: `BIO-${token}`,
        firstName: "Synthetic",
        lastName: "Sequence",
        email: `biometric-${token}@test.invalid`,
        phone: "+27820000021",
      },
    })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("orders tied timestamps by the database-assigned attempt chronology", async () => {
    const older = await db.clientDocument.create({
      data: {
        id: `zz_older_selfie_${token}`,
        tenantId,
        clientId,
        docType: "SELFIE",
        fileUrl: "",
        fileName: "older.jpg",
        createdAt: tiedAt,
      },
    })
    const newer = await db.clientDocument.create({
      data: {
        id: `aa_newer_selfie_${token}`,
        tenantId,
        clientId,
        docType: "SELFIE",
        fileUrl: "",
        fileName: "newer.jpg",
        createdAt: tiedAt,
      },
    })

    expect(older.biometricAttemptSequence).toBe(1)
    expect(newer.biometricAttemptSequence).toBe(2)
    await expect(db.clientDocument.findFirst({
      where: { tenantId, clientId, docType: "SELFIE" },
      orderBy: latestSelfieOrder(),
      select: { id: true },
    })).resolves.toEqual({ id: newer.id })
  })

  it("serializes concurrent legacy-style inserts that omit the sequence", async () => {
    const created = await Promise.all([
      db.clientDocument.create({
        data: {
          id: `concurrent_a_${token}`,
          tenantId,
          clientId,
          docType: "SELFIE",
          fileUrl: "",
          fileName: "concurrent-a.jpg",
          createdAt: tiedAt,
        },
      }),
      db.clientDocument.create({
        data: {
          id: `concurrent_b_${token}`,
          tenantId,
          clientId,
          docType: "SELFIE",
          fileUrl: "",
          fileName: "concurrent-b.jpg",
          createdAt: tiedAt,
        },
      }),
    ])

    expect(created.map(({ biometricAttemptSequence }) => biometricAttemptSequence).sort())
      .toEqual([3, 4])
  })
})
