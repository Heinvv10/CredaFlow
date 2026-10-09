/**
 * Cross-layer proof for in-person KYC verification.
 *
 * The database enforces its own composite-KYC floor via a BEFORE UPDATE trigger
 * on Client, independently of the application. Unit tests cannot see it: they
 * exercise pure functions and never open a connection. A feature can pass
 * tsc, lint, a full unit suite and a production build while its only write is
 * rejected by that trigger on every call. This test covers
 * that defect and proves the two layers agree, which matters because a
 * divergence means one accepts what the other rejects.
 *
 * It is env-gated and NOT part of `npm test`, so it only catches such a
 * defect when someone runs it. Wiring
 * a CI job for the RUN_*_IT suites is the open follow-up.
 *
 * Run against a throwaway fully migrated PostgreSQL database:
 *
 *   docker run -d --name kyc-probe -e POSTGRES_PASSWORD=probe \
 *     -e POSTGRES_DB=probe -p 55433:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres:probe@127.0.0.1:55433/probe \
 *     npx prisma migrate deploy
 *   RUN_KYC_IN_PERSON_IT=1 DATABASE_URL=postgresql://postgres:probe@127.0.0.1:55433/probe \
 *     npx vitest run lib/kyc/in-person-verification.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

const RUN = process.env.RUN_KYC_IN_PERSON_IT === "1"
const suite = RUN ? describe : describe.skip
const db = new PrismaClient()

const token = randomUUID().replaceAll("-", "")
const tenantId = `t_${token}`
const clientId = `c_${token}`
const idDocumentId = `d_id_${token}`
const ID_SHA = "a".repeat(64)
// idNumber is globally unique and the immutable compliance evidence keeps the
// client row alive after teardown, so this must differ per run or a second run
// against the same database collides in beforeAll.
const idNumber = `8905${token.replace(/\D/g, "").padEnd(9, "0").slice(0, 9)}`

async function setKycVerified(): Promise<boolean> {
  try {
    await db.client.update({ where: { id: clientId }, data: { kycStatus: "VERIFIED" } })
    await db.client.update({ where: { id: clientId }, data: { kycStatus: "PENDING" } })
    return true
  } catch {
    return false
  }
}

async function appAcceptsEvidence(): Promise<boolean> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const state = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId,
    clientId,
    subject: client,
    existing: client,
    preserveVerifiedProvenance: false,
  })
  return state.ok
}

/** Both layers must reach the same verdict, whatever that verdict is. */
async function verdict(): Promise<{ db: boolean; app: boolean }> {
  return { db: await setKycVerified(), app: await appAcceptsEvidence() }
}

suite("in-person KYC verification across the app and database layers", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `probe-${token}`, name: "Probe" } })
    await db.client.create({
      data: {
        id: clientId, tenantId, reference: `CL-${token}`, idNumber,
        firstName: "Dineo", lastName: "Testperson", email: `${token}@example.com`,
        phone: "0600000000", dateOfBirth: new Date("1989-05-31T00:00:00.000Z"),
        kycStatus: "PENDING",
      },
    })
    await db.clientDocument.createMany({
      data: [
        { id: idDocumentId, clientId, tenantId, docType: "ID_COPY", fileUrl: "/f", fileName: "id.pdf", verified: true, contentSha256: ID_SHA },
        { id: `d_poa_${token}`, clientId, tenantId, docType: "PROOF_OF_ADDRESS", fileUrl: "/f", fileName: "poa.pdf", verified: true, contentSha256: "b".repeat(64) },
        { id: `d_pay_${token}`, clientId, tenantId, docType: "PAYSLIP", fileUrl: "/f", fileName: "pay.pdf", verified: true, contentSha256: "c".repeat(64) },
        { id: `d_bank_${token}`, clientId, tenantId, docType: "BANK_STATEMENT", fileUrl: "/f", fileName: "bank.pdf", verified: true, contentSha256: "d".repeat(64) },
      ],
    })
  })

  afterAll(async () => {
    // Completed KYC_EXCEPTION rows are deliberately immutable at the storage
    // layer, so they cannot be deleted even here. Everything is namespaced by a
    // per-run token and this is a throwaway database, so leaving the evidence
    // behind is correct rather than defeating the immutability guarantee.
    try {
      await db.clientDocument.deleteMany({ where: { tenantId } })
      await db.client.deleteMany({ where: { tenantId } })
      await db.tenant.deleteMany({ where: { id: tenantId } })
    } catch {
      // Immutable compliance evidence keeps its FKs alive; nothing to undo.
    }
    await db.$disconnect()
  })

  it("rejects VERIFIED with four verified documents but no biometric evidence", async () => {
    // The dead end staff hit: documents all done, KYC still refused.
    expect(await verdict()).toEqual({ db: false, app: false })
  })

  it("accepts VERIFIED once an in-person attestation is recorded", async () => {
    const completedAt = new Date()
    completedAt.setMilliseconds(completedAt.getMilliseconds()) // TIMESTAMP(3)
    const [{ fingerprint }] = await db.$queryRawUnsafe<{ fingerprint: string }[]>(
      `SELECT "biometric_subject_fingerprint"($1,$2,$3,$4,$5::timestamp(3)) AS fingerprint`,
      clientId, idNumber, "Dineo", "Testperson", new Date("1989-05-31T00:00:00.000Z"),
    )
    await db.complianceRecord.create({
      data: {
        id: `cr_${token}`, tenantId, type: "KYC_EXCEPTION", referenceId: clientId,
        status: "COMPLETED", completedAt,
        data: {
          kind: IN_PERSON_KYC_VERIFICATION_KIND,
          version: IN_PERSON_KYC_VERIFICATION_VERSION,
          clientId,
          idDocumentId,
          idDocumentSha256: ID_SHA,
          subjectFingerprint: fingerprint,
          method: "IN_PERSON_BRANCH",
          note: "Client attended Hendrina branch; face matched the ID photo.",
          approvedAt: completedAt.toISOString(),
          approvedById: "admin-1",
          approvedByEmail: "admin@acme-lending.example",
        },
      },
    })

    expect(await verdict()).toEqual({ db: true, app: true })
  })

  it("SURVIVES a failed selfie attempt, in both layers", async () => {
    // Regression: any selfie row — even a failed attempt —
    // permanently closed the in-person route in both enforcement layers.
    const selfieId = `d_selfie_failed_${token}`
    await db.clientDocument.create({
      data: {
        id: selfieId, clientId, tenantId, docType: "SELFIE", fileUrl: "/f",
        fileName: "s.jpg", verified: false, contentSha256: "e".repeat(64),
        extractionStatus: "failed", validationMismatch: true,
      },
    })
    expect(await verdict()).toEqual({ db: true, app: true })
    await db.clientDocument.delete({ where: { id: selfieId } })
  })

  it("survives a soft-deleted attempt, in both layers", async () => {
    const selfieId = `d_selfie_deleted_${token}`
    await db.clientDocument.create({
      data: {
        id: selfieId, clientId, tenantId, docType: "SELFIE", fileUrl: "/f",
        fileName: "s.jpg", verified: false, contentSha256: "e".repeat(64),
        extractionStatus: "failed", deletedAt: new Date(),
      },
    })
    expect(await verdict()).toEqual({ db: true, app: true })
    await db.clientDocument.delete({ where: { id: selfieId } })
  })

  it("stops applying while a biometric attempt is still processing, in both layers", async () => {
    const selfieId = `d_selfie_processing_${token}`
    await db.clientDocument.create({
      data: {
        id: selfieId, clientId, tenantId, docType: "SELFIE", fileUrl: "/f",
        fileName: "s.jpg", verified: false, contentSha256: "e".repeat(64),
        extractionStatus: "processing",
      },
    })
    expect(await verdict()).toEqual({ db: false, app: false })
    await db.clientDocument.delete({ where: { id: selfieId } })
    expect(await verdict()).toEqual({ db: true, app: true })
  })

  it("stops applying once a selfie carries passing provider-verified evidence, in both layers", async () => {
    const selfieId = `d_selfie_passed_${token}`
    await db.clientDocument.create({
      data: {
        id: selfieId, clientId, tenantId, docType: "SELFIE", fileUrl: "/f",
        fileName: "s.jpg", verified: true, contentSha256: "e".repeat(64),
        extractionStatus: "done", biometricVerifiedAt: new Date(),
      },
    })
    expect(await verdict()).toEqual({ db: false, app: false })
    await db.clientDocument.delete({ where: { id: selfieId } })
    expect(await verdict()).toEqual({ db: true, app: true })
  })

  it("stops applying when the bound ID document is replaced, in both layers", async () => {
    await db.clientDocument.update({ where: { id: idDocumentId }, data: { contentSha256: "f".repeat(64) } })
    expect(await verdict()).toEqual({ db: false, app: false })
    await db.clientDocument.update({ where: { id: idDocumentId }, data: { contentSha256: ID_SHA } })
    expect(await verdict()).toEqual({ db: true, app: true })
  })

  it("stops applying when the client's identity is edited, in both layers", async () => {
    await db.client.update({ where: { id: clientId }, data: { firstName: "Dineoe" } })
    expect(await verdict()).toEqual({ db: false, app: false })
    await db.client.update({ where: { id: clientId }, data: { firstName: "Dineo" } })
    expect(await verdict()).toEqual({ db: true, app: true })
  })

  it("cannot rescue a missing core document, in both layers", async () => {
    await db.clientDocument.update({ where: { id: `d_pay_${token}` }, data: { verified: false } })
    expect(await verdict()).toEqual({ db: false, app: false })
    await db.clientDocument.update({ where: { id: `d_pay_${token}` }, data: { verified: true } })
    expect(await verdict()).toEqual({ db: true, app: true })
  })
})
