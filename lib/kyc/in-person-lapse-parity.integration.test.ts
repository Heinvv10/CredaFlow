/**
 * Cross-layer parity for the in-person lapse rule (migration
 * 20261014120000_in_person_lapse_on_adverse_verdict): for every selfie shape
 * below the database (Client composite-KYC trigger) and the application
 * (readCompositeKycState) must reach the SAME verdict, and
 * face_verdict_is_adverse must agree with adverseFaceVerdict.
 *
 *   RUN_KYC_IN_PERSON_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/in-person-lapse-parity.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Prisma, PrismaClient } from "@prisma/client"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import { adverseFaceVerdict } from "@/lib/kyc/biometric-evidence"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

const RUN = process.env.RUN_KYC_IN_PERSON_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()

const token = randomUUID().replaceAll("-", "")
const tenantId = `t_lapse_${token}`
const clientId = `c_lapse_${token}`
const reviewerId = `reviewer_lapse_${token}`
const idDocumentId = `d_id_lapse_${token}`
const ID_SHA = "a".repeat(64)
const idNumber = `8906${token.replace(/\D/g, "").padEnd(9, "0").slice(0, 9)}`
const DOB = new Date("1989-05-31T00:00:00.000Z")
let completedAt = new Date()
let selfieCount = 0
const created: string[] = []

const iso = (offsetMs: number) => new Date(completedAt.getTime() + offsetMs).toISOString()
const DIFFERENT = { samePerson: "different", faceMatch: false }

async function dbAccepts(): Promise<boolean> {
  try {
    await db.client.update({ where: { id: clientId }, data: { kycStatus: "VERIFIED" } })
    await db.client.update({ where: { id: clientId }, data: { kycStatus: "PENDING" } })
    return true
  } catch {
    return false
  }
}

async function appAccepts(): Promise<boolean> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const state = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId, clientId, subject: client, existing: client, preserveVerifiedProvenance: false,
  })
  return state.ok
}

/** One failed selfie attempt with the given stored result. */
async function selfie(
  biometricResult: unknown,
  over: { createdAt?: Date; deletedAt?: Date; extractionStatus?: string; rejected?: boolean } = {},
) {
  const { rejected, ...columns } = over
  selfieCount += 1
  const id = `d_selfie_lapse_${selfieCount}_${token}`
  await db.clientDocument.create({
    data: {
      id, clientId, tenantId, docType: "SELFIE", fileUrl: "/f", fileName: "s.jpg", verified: false,
      contentSha256: "e".repeat(64), extractionStatus: "failed", validationMismatch: true,
      biometricResult: biometricResult as Prisma.InputJsonValue, ...columns,
      ...(rejected ? { verificationRejectedAt: new Date(), verificationRejectedById: reviewerId } : {}),
    },
  })
  created.push(id)
}

const stamped = (offsetMs: number, verdict: Record<string, unknown>, id: string | null = idDocumentId) => ({
  verdictRecordedAt: iso(offsetMs), ...(id ? { idDocumentId: id } : {}), faceVerdict: verdict,
  biometricFailureReason: "match_score_below_threshold",
})

suite("in-person lapse rule across the app and database layers", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `lapse-${token}`, name: "Lapse" } })
    await db.user.create({ data: {
      id: reviewerId, tenantId, email: `reviewer-lapse-${token}@test.invalid`, password: "synthetic",
      role: "ADMIN", active: true, totpEnabled: true, lastTotpCounter: 1,
    } })
    await db.client.create({
      data: {
        id: clientId, tenantId, reference: `CL-LAPSE-${token}`, idNumber, firstName: "Dineo", lastName: "Testperson",
        email: `lapse-${token}@example.com`, phone: "0600000001", dateOfBirth: DOB, kycStatus: "PENDING",
      },
    })
    await db.clientDocument.createMany({
      data: [
        { id: idDocumentId, clientId, tenantId, docType: "ID_COPY", fileUrl: "/f", fileName: "id.pdf", verified: true, contentSha256: ID_SHA },
        { id: `d_poa_lapse_${token}`, clientId, tenantId, docType: "PROOF_OF_ADDRESS", fileUrl: "/f", fileName: "poa.pdf", verified: true, contentSha256: "b".repeat(64) },
        { id: `d_pay_lapse_${token}`, clientId, tenantId, docType: "PAYSLIP", fileUrl: "/f", fileName: "pay.pdf", verified: true, contentSha256: "c".repeat(64) },
        { id: `d_bank_lapse_${token}`, clientId, tenantId, docType: "BANK_STATEMENT", fileUrl: "/f", fileName: "bank.pdf", verified: true, contentSha256: "d".repeat(64) },
      ],
    })
    const [{ fingerprint }] = await db.$queryRawUnsafe<{ fingerprint: string }[]>(
      `SELECT "biometric_subject_fingerprint"($1,$2,$3,$4,$5::timestamp(3)) AS fingerprint`,
      clientId, idNumber, "Dineo", "Testperson", DOB,
    )
    completedAt = new Date()
    await db.complianceRecord.create({
      data: {
        id: `cr_lapse_${token}`, tenantId, type: "KYC_EXCEPTION", referenceId: clientId, status: "COMPLETED", completedAt,
        data: {
          kind: IN_PERSON_KYC_VERIFICATION_KIND, version: IN_PERSON_KYC_VERIFICATION_VERSION, clientId,
          idDocumentId, idDocumentSha256: ID_SHA, subjectFingerprint: fingerprint, method: "IN_PERSON_BRANCH",
          note: "Client attended Hendrina branch; face matched the ID photo.",
          approvedAt: completedAt.toISOString(), approvedById: reviewerId,
          approvedByEmail: `reviewer-lapse-${token}@test.invalid`, approvedWithTotp: true,
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  afterEach(async () => {
    await db.clientDocument.deleteMany({ where: { id: { in: created.splice(0) } } })
  })

  afterAll(async () => {
    try {
      await db.clientDocument.deleteMany({ where: { tenantId } })
      await db.client.deleteMany({ where: { tenantId } })
      await db.tenant.deleteMany({ where: { id: tenantId } })
    } catch {
      // Completed KYC_EXCEPTION rows are immutable and keep their FKs alive.
    }
    await db.$disconnect()
  })

  it("accepts the attestation with no selfie at all", async () => {
    expect({ db: await dbAccepts(), app: await appAccepts() }).toEqual({ db: true, app: true })
  })

  // [name, selfies to create, does the attestation still stand?]
  const cases: Array<[string, () => Promise<void>, boolean]> = [
    ["adverse verdict recorded after, on the attested ID", () => selfie(stamped(1_000, DIFFERENT)), false],
    ["a non-'same' answer other than 'different'", () => selfie(stamped(1_000, { samePerson: "uncertain" })), false],
    ["an adverse face model answer", () => selfie(stamped(1_000, { faceModelSamePerson: false })), false],
    ["an adverse top-level answer", () => selfie({ ...stamped(1_000, {}), faceMatch: false }), false],
    ["an adverse nested face model answer", () => selfie({ ...stamped(1_000, {}), faceModel: { samePerson: false } }), false],
    ["the same adverse verdict on a DELETED latest attempt", () => selfie(stamped(1_000, DIFFERENT), { deletedAt: new Date() }), false],
    ["recorded in the same millisecond as the attestation (cannot be ordered)", () => selfie(stamped(0, DIFFERENT)), false],
    ["recorded before the attestation (staff saw it)", () => selfie(stamped(-1_000, DIFFERENT)), true],
    ["recorded after but about a superseded ID copy", () => selfie(stamped(1_000, DIFFERENT, "d_old_id")), true],
    ["recorded after and naming no ID copy (fail closed)", () => selfie(stamped(1_000, DIFFERENT, null)), false],
    ["recorded after but a passing answer", () => selfie(stamped(1_000, { samePerson: "same", faceMatch: true })), true],
    ["recorded after with JSON null answers", () => selfie(stamped(1_000, { samePerson: null, faceMatch: null })), true],
    ["a stamp that is not the fixed ISO format", () => selfie({ ...stamped(1_000, DIFFERENT), verdictRecordedAt: "2099-01-01 00:00:00" }), true],
    ["a numeric stamp", () => selfie({ ...stamped(1_000, DIFFERENT), verdictRecordedAt: 4102444800000 }), true],
    ["an adverse verdict without a stamp (written before the stamp existed)", () => selfie({ idDocumentId, faceVerdict: DIFFERENT }), true],
    // A benign-failing retake must not bury the verdict: any attempt counts.
    ["an adverse-after verdict on an OLDER attempt behind a newer benign one", async () => {
      await selfie(stamped(1_000, DIFFERENT))
      await selfie({ biometricFailureReason: "extraction_incomplete" })
    }, false],
    ["an adverse-after verdict on an OLDER DELETED attempt behind a newer benign one", async () => {
      await selfie(stamped(1_000, DIFFERENT), { deletedAt: new Date() })
      await selfie({ biometricFailureReason: "image_unusable" })
    }, false],
    ["an adverse-after verdict on an older attempt that staff REJECTED while it was 'done'", () =>
      selfie(stamped(1_000, DIFFERENT), { extractionStatus: "done", rejected: true }), false],
    // Both layers read the same attempts: a 'done', unrejected row is none of them.
    ["an adverse-after verdict on a 'done' attempt", () => selfie(stamped(1_000, DIFFERENT), { extractionStatus: "done" }), true],
    ["an unknown outcome on a 'done' attempt", () =>
      selfie({ biometricFailureReason: "biometric_outcome_not_recorded" }, { extractionStatus: "done" }), true],
    ["an unknown outcome on a 'skipped' attempt", () =>
      selfie({ biometricFailureReason: "biometric_outcome_not_recorded" }, { extractionStatus: "skipped" }), false],
    ["an unknown outcome submitted after the attestation", () => selfie({ biometricFailureReason: "biometric_outcome_not_recorded" }), false],
    ["an unknown outcome on an older attempt behind a newer benign one", async () => {
      await selfie({ biometricFailureReason: "biometric_outcome_not_recorded" })
      await selfie({ biometricFailureReason: "extraction_incomplete" })
    }, false],
    ["an unknown outcome submitted BEFORE the attestation", () => selfie(
      { biometricFailureReason: "biometric_outcome_not_recorded" }, { createdAt: new Date(completedAt.getTime() - 3_600_000) }), true],
    ["an unknown outcome created in the same millisecond as the attestation", () => selfie(
      { biometricFailureReason: "biometric_outcome_not_recorded" }, { createdAt: new Date(completedAt.getTime()) }), false],
    // The sweeper's marker outlives the late answer that replaced the reason.
    ["a swept attempt after the attestation whose late answer replaced the reason", () => selfie(
      { biometricFailureReason: "subject_identity_changed", sweptAt: iso(500), idDocumentId: "d_other_id", faceVerdict: DIFFERENT }), false],
    ["a swept attempt BEFORE the attestation whose late answer replaced the reason", () => selfie(
      { biometricFailureReason: "subject_identity_changed", sweptAt: iso(-500) }, { createdAt: new Date(completedAt.getTime() - 3_600_000) }), true],
    ["a non-string sweptAt marker", () => selfie({ biometricFailureReason: "face_not_detected", sweptAt: 5 }), true],
    // An ID-portrait refusal is a fact about the copy; the worker's own reason survives an override.
    ["the worker's own ID-portrait refusal behind a replaced reason, naming the attested copy", () => selfie(
      { biometricFailureReason: "subject_identity_changed", workerFailureReason: "id_document_portrait_invalid", idDocumentId }), false],
    ["the worker's own ID-portrait refusal naming no copy (fail closed)", () => selfie(
      { biometricFailureReason: "subject_identity_changed", workerFailureReason: "id_document_portrait_invalid" }), false],
    ["the worker's own ID-portrait refusal about another copy", () => selfie(
      { biometricFailureReason: "subject_identity_changed", workerFailureReason: "id_document_portrait_invalid", idDocumentId: "d_other_id", idDocumentSha256: "9".repeat(64) }), true],
    ["a worker reason that is not a portrait refusal", () => selfie(
      { biometricFailureReason: "subject_identity_changed", workerFailureReason: "face_not_detected", idDocumentId }), true],
    // Deleted while in flight: no writer touches it again, so it has no reason and no marker.
    ["a selfie deleted while processing, submitted after the attestation", () => selfie(
      {}, { extractionStatus: "processing", deletedAt: new Date() }), false],
    ["a selfie deleted while pending, submitted after the attestation", () => selfie(
      {}, { extractionStatus: "pending", deletedAt: new Date() }), false],
    ["a selfie deleted while processing, submitted BEFORE the attestation", () => selfie(
      {}, { extractionStatus: "processing", deletedAt: new Date(), createdAt: new Date(completedAt.getTime() - 3_600_000) }), true],
    ["a selfie deleted after it failed, submitted after the attestation", () => selfie(
      { biometricFailureReason: "face_not_detected" }, { extractionStatus: "failed", deletedAt: new Date() }), true],
    ["a benign failure submitted after the attestation", () => selfie({ biometricFailureReason: "face_not_detected" }), true],
  ]

  it.each(cases)("%s", async (_name, setup, stands) => {
    await setup()
    expect({ db: await dbAccepts(), app: await appAccepts() }).toEqual({ db: stands, app: stands })
  })

  // Shapes a stored result may take, including ones only a corrupt writer produces.
  const shapes: unknown[] = [
    null, "x", 3, [], [{ samePerson: "different" }], {},
    { samePerson: "same" }, { samePerson: "different" }, { samePerson: null }, { samePerson: false },
    { faceMatch: true }, { faceMatch: false }, { faceMatch: "true" }, { faceMatch: null },
    { faceModel: { samePerson: true } }, { faceModel: { samePerson: false } }, { faceModel: [] }, { faceModel: "x" },
    { faceVerdict: { samePerson: "same", faceMatch: true, faceModelSamePerson: true } },
    { faceVerdict: { samePerson: "different" } }, { faceVerdict: { faceMatch: 0 } },
    { faceVerdict: { faceModelSamePerson: false } }, { faceVerdict: "different" }, { faceVerdict: [{ samePerson: "x" }] },
    { samePerson: "same", faceVerdict: { faceMatch: false } },
  ]

  it.each(shapes.map((shape) => [JSON.stringify(shape), shape] as const))(
    "face_verdict_is_adverse agrees with adverseFaceVerdict on %s",
    async (_label, shape) => {
      const [{ adverse }] = await db.$queryRawUnsafe<Array<{ adverse: boolean }>>(
        `SELECT "face_verdict_is_adverse"($1::jsonb) AS adverse`, JSON.stringify(shape),
      )
      const record = shape && typeof shape === "object" && !Array.isArray(shape) ? shape as Record<string, unknown> : null
      expect(adverse).toBe(adverseFaceVerdict(record))
    },
  )
})
