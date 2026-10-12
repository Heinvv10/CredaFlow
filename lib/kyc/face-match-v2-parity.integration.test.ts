/**
 * TypeScript vs SQL parity for stored selfie evidence: for each case, the app's
 * composite gate (readCompositeKycState, as /review, /decide and /disburse call
 * it) and subject_has_composite_kyc must both reach the EXPECTED verdict. The
 * evidence JSON is written as raw text, so number spellings, string booleans
 * and duplicate keys reach the database exactly as written.
 *
 *   RUN_FACE_MATCH_V2_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/face-match-v2-parity.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

const RUN = process.env.RUN_FACE_MATCH_V2_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const ID_SHA = "a".repeat(64)
let sequence = 0

// Placeholders substituted per case.
const FP = "__FP__"
const ID = "__ID__"
const BR = (change = "") =>
  `{"ok":true,"verified":true,"provider":"vlm-face-match-v2","matchScore":95,"livenessScore":97,` +
  `"idPhotoKind":"photograph","idPhotoIsRealPhotograph":true,"idPhotoFaceDetected":true,` +
  `"selfieIsRealPhotograph":true,"samePerson":"same","faceMatch":true,"matchConfidence":0.95,` +
  `"livenessConfidence":0.97,"idDocumentId":"${ID}","idDocumentSha256":"${ID_SHA}",` +
  `"subjectFingerprint":"${FP}"${change ? "," + change : ""}}`
const ER = (change = "") =>
  `{"faceDetected":{"value":true},"facesCount":{"value":1},"isLive":{"value":true},` +
  `"quality":{"value":"good"}${change ? "," + change : ""}}`
const FAILED = (reason: string, change = `"idDocumentId":"${ID}","idDocumentSha256":"${ID_SHA}"`) =>
  `{"biometricFailureReason":"${reason}","subjectFingerprint":"${FP}"${change ? "," + change : ""}}`

type Case = {
  name: string
  expected: boolean
  br?: string
  er?: string
  cols?: string
  /** Rows to add before the selfie, given the seeded ID copy's id. */
  before?: (ids: Ids) => string[]
  /** A failed latest selfie and an in-person attestation instead of a pass. */
  inPerson?: { br: string; deleted?: boolean; older?: string; olderDeleted?: boolean }
}
type Ids = { tenantId: string; clientId: string; idCopyId: string }

// JSON duplicate keys: the later one wins in both JSON.parse and jsonb.
const cases: Case[] = [
  { name: "control: consistent v2 pass", expected: true },
  { name: "ok is the string \"true\"", expected: false, br: BR(`"ok":"true"`) },
  { name: "verified is the string \"true\"", expected: false, br: BR(`"verified":"true"`) },
  { name: "ok and verified both strings", expected: false, br: BR(`"ok":"true","verified":"true"`) },
  { name: "simulated is the string \"true\"", expected: false, br: BR(`"simulated":"true"`) },
  { name: "simulated is 1", expected: false, br: BR(`"simulated":1`) },
  { name: "simulated is null", expected: false, br: BR(`"simulated":null`) },
  { name: "simulated is false", expected: true, br: BR(`"simulated":false`) },
  { name: "provider mixed case", expected: false, br: BR(`"provider":"VLM-Face-Match-V2"`) },
  { name: "provider with a trailing space", expected: false, br: BR(`"provider":"vlm-face-match-v2 "`) },
  { name: "provider as an array", expected: false, br: BR(`"provider":["vlm-face-match-v2"]`) },
  { name: "provider v1 with an extra providerV2 tag", expected: false, br: BR(`"provider":"vlm-face-match-v1","providerV2":"vlm-face-match-v2"`) },
  { name: "idPhotoKind upper case", expected: false, br: BR(`"idPhotoKind":"PHOTOGRAPH"`) },
  { name: "idPhotoKind silhouette", expected: false, br: BR(`"idPhotoKind":"silhouette_placeholder"`) },
  { name: "idPhotoKind nested in {value}", expected: false, br: BR(`"idPhotoKind":{"value":"photograph"}`) },
  { name: "idPhotoIsRealPhotograph the string true", expected: false, br: BR(`"idPhotoIsRealPhotograph":"true"`) },
  { name: "idPhotoFaceDetected 1", expected: false, br: BR(`"idPhotoFaceDetected":1`) },
  { name: "selfieIsRealPhotograph null", expected: false, br: BR(`"selfieIsRealPhotograph":null`) },
  { name: "faceMatch the string true", expected: false, br: BR(`"faceMatch":"true"`) },
  { name: "samePerson upper case", expected: false, br: BR(`"samePerson":"SAME"`) },
  { name: "samePerson uncertain with faceMatch true", expected: false, br: BR(`"samePerson":"uncertain"`) },
  { name: "matchConfidence a string", expected: false, br: BR(`"matchConfidence":"0.95"`) },
  { name: "matchConfidence exactly 0.7", expected: true, br: BR(`"matchConfidence":0.7`) },
  { name: "matchConfidence 1.5", expected: false, br: BR(`"matchConfidence":1.5`) },
  { name: "matchConfidence an array", expected: false, br: BR(`"matchConfidence":[0.95]`) },
  { name: "matchScore a string", expected: false, br: BR(`"matchScore":"95"`) },
  { name: "matchScore 5 against matchConfidence 0.95", expected: false, br: BR(`"matchScore":5`) },
  { name: "matchScore 1000000", expected: true, br: BR(`"matchScore":1000000`) },
  { name: "livenessScore 69.5", expected: false, br: BR(`"livenessScore":69.5`) },
  { name: "a pass that also carries a failure reason and error", expected: true, br: BR(`"biometricFailureReason":"id_document_portrait_invalid","error":"synthetic"`) },
  { name: "duplicate key: faceMatch false then true", expected: true, br: BR(`"faceMatch":false,"faceMatch":true`) },
  { name: "duplicate key: faceMatch true then false", expected: false, br: BR(`"faceMatch":true,"faceMatch":false`) },
  { name: "biometricResult an array wrapping the pass", expected: false, br: `[${BR()}]` },
  { name: "v1-shaped evidence", expected: false, br: `{"ok":true,"verified":true,"provider":"vlm-face-match-v1","matchScore":95,"livenessScore":97,"faceMatch":true,"idDocumentId":"${ID}","idDocumentSha256":"${ID_SHA}","subjectFingerprint":"${FP}"}` },
  { name: "untagged evidence", expected: false, br: `{"ok":true,"verified":true,"matchScore":95,"livenessScore":97,"idDocumentId":"${ID}","idDocumentSha256":"${ID_SHA}","subjectFingerprint":"${FP}"}` },
  { name: "fingerprint upper case", expected: false, br: BR().replace(FP, "__FPUP__") },

  // The ID copy the match is bound to.
  { name: "no idDocumentId", expected: false, br: BR().replace(`"idDocumentId":"${ID}",`, "") },
  { name: "no idDocumentSha256", expected: false, br: BR().replace(`"idDocumentSha256":"${ID_SHA}",`, "") },
  { name: "idDocumentId of another document", expected: false, br: BR(`"idDocumentId":"some-other-document"`) },
  { name: "idDocumentSha256 not the copy's digest", expected: false, br: BR(`"idDocumentSha256":"${"b".repeat(64)}"`) },
  { name: "idDocumentId nested in an array", expected: false, br: BR(`"idDocumentId":["${ID}"]`) },
  {
    name: "bound to an older verified copy while a newer one is verified",
    expected: false,
    before: (ids) => [newerIdCopy(ids, "newer_verified", true, "b".repeat(64))],
  },
  {
    name: "bound to the newest verified copy while a newer one awaits verification",
    expected: true,
    before: (ids) => [newerIdCopy(ids, "newer_unverified", false, "b".repeat(64))],
  },
  {
    name: "bound to a newer copy that is not verified",
    expected: false,
    before: (ids) => [newerIdCopy(ids, "substitute", false, "b".repeat(64))],
    br: BR(`"idDocumentId":"__SUBSTITUTE__","idDocumentSha256":"${"b".repeat(64)}"`),
  },
  {
    name: "bound to the newest verified copy, which has no digest",
    expected: false,
    cols: `"biometricResult" = jsonb_set("biometricResult", '{idDocumentSha256}', 'null'::jsonb)`,
    before: (ids) => [`UPDATE "ClientDocument" SET "contentSha256" = NULL WHERE "id" = '${ids.idCopyId}'`],
  },
  {
    name: "bound to a copy since deleted, an older verified copy remaining",
    expected: false,
    before: (ids) => [
      olderIdCopy(ids, "older_verified"),
      `UPDATE "ClientDocument" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = '${ids.idCopyId}'`,
    ],
  },

  // extractionResult
  { name: "extraction vlmUnavailable true beside a v2 verdict", expected: true, er: `{"vlmUnavailable":true}` },
  { name: "extraction vlmUnavailable the string true", expected: false, er: `{"vlmUnavailable":"true"}` },
  { name: "extraction faceDetected the string true", expected: false, er: ER(`"faceDetected":{"value":"true"}`) },
  { name: "extraction isLive the string true", expected: false, er: ER(`"isLive":{"value":"true"}`) },
  { name: "extraction facesCount the string 1", expected: false, er: ER(`"facesCount":{"value":"1"}`) },
  { name: "extraction facesCount 1.0", expected: true, er: ER(`"facesCount":{"value":1.0}`) },
  { name: "extraction facesCount 1e0", expected: true, er: ER(`"facesCount":{"value":1e0}`) },
  { name: "extraction facesCount 2", expected: false, er: ER(`"facesCount":{"value":2}`) },
  { name: "extraction quality GOOD with spaces", expected: true, er: ER(`"quality":{"value":"  GOOD "}`) },
  { name: "extraction quality good with a trailing newline", expected: false, er: ER(`"quality":{"value":"good\\n"}`) },
  { name: "extraction quality poor with a leading tab", expected: false, er: ER(`"quality":{"value":"\\tpoor"}`) },
  { name: "extraction quality unusable", expected: false, er: ER(`"quality":{"value":"unusable"}`) },
  { name: "extraction isLive false", expected: false, er: ER(`"isLive":{"value":false}`) },
  { name: "extraction an array", expected: false, er: `[${ER()}]` },

  // columns
  { name: "column validationScore 69", expected: false, cols: `"validationScore" = 69` },
  { name: "column biometricLiveness 69", expected: false, cols: `"biometricLiveness" = 69` },
  { name: "column validationMismatch true", expected: false, cols: `"validationMismatch" = true` },
  { name: "column biometricVerifiedAt null", expected: false, cols: `"biometricVerifiedAt" = NULL` },
  { name: "column verified false", expected: false, cols: `"verified" = false` },
  { name: "column extractionStatus DONE", expected: false, cols: `"extractionStatus" = 'DONE'` },
  { name: "column deletedAt set", expected: false, cols: `"deletedAt" = CURRENT_TIMESTAMP` },

  // The in-person route over a failed latest selfie.
  { name: "in person: latest selfie refused this ID copy's portrait", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid") } },
  { name: "in person: the refusal names no ID copy", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid", "") } },
  { name: "in person: the refusal names an ID copy as a non-string", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid", `"idDocumentId":7`) } },
  { name: "in person: the refused selfie is soft-deleted", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid"), deleted: true } },
  { name: "in person: the refusal was of an older ID copy", expected: true, inPerson: { br: FAILED("id_document_portrait_invalid", `"idDocumentId":"an-older-id-copy"`) } },
  { name: "in person: latest selfie refused as not a real photograph", expected: true, inPerson: { br: FAILED("selfie_not_real_photograph") } },
  // ANY attempt bound to this copy keeps it closed, not only the latest.
  { name: "in person: an older attempt refused the portrait, the latest failed otherwise", expected: false, inPerson: { br: FAILED("face_not_detected"), older: FAILED("id_document_portrait_invalid") } },
  { name: "in person: a deleted older refusal, the latest not a real photograph", expected: false, inPerson: { br: FAILED("selfie_not_real_photograph"), older: FAILED("id_document_portrait_invalid"), olderDeleted: true } },
  { name: "in person: an older refusal of another ID copy, the latest failed otherwise", expected: true, inPerson: { br: FAILED("face_not_detected"), older: FAILED("id_document_portrait_invalid", `"idDocumentId":"an-older-id-copy","idDocumentSha256":"${"b".repeat(64)}"`) } },
  // The same bytes re-uploaded under a new row are the same photo-less ID.
  { name: "in person: the refusal names another row with this copy's bytes", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid", `"idDocumentId":"an-older-id-copy","idDocumentSha256":"${ID_SHA}"`) } },
  { name: "in person: the refusal names only this copy's digest", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid", `"idDocumentSha256":"${ID_SHA}"`) } },
  { name: "in person: the refusal names only another digest", expected: true, inPerson: { br: FAILED("id_document_portrait_invalid", `"idDocumentSha256":"${"b".repeat(64)}"`) } },
  { name: "in person: the refusal names this row but other bytes", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid", `"idDocumentId":"${ID}","idDocumentSha256":"${"b".repeat(64)}"`) } },
  { name: "in person: the refusal names this row and no digest", expected: false, inPerson: { br: FAILED("id_document_portrait_invalid", `"idDocumentId":"${ID}"`) } },
]

/**
 * Pinned divergence, in the fail-closed direction only: decimals that differ
 * from a passing value beyond IEEE-754 double precision. Prisma hands the app
 * JSON.parse'd doubles, so TypeScript reads 0.69999999999999999999 as 0.7;
 * SQL compares the exact numeric and refuses. No writer produces these
 * (JSON.stringify never emits them), and making SQL agree would loosen the
 * baseline's numeric comparisons.
 */
const doublePrecisionCases: Case[] = [
  { name: "matchConfidence 0.69999999999999999999", expected: false, br: BR(`"matchConfidence":0.69999999999999999999`) },
  { name: "matchConfidence 1.00000000000000000001", expected: false, br: BR(`"matchConfidence":1.00000000000000000001`) },
  { name: "livenessConfidence 0.69999999999999999999", expected: false, br: BR(`"livenessConfidence":0.69999999999999999999`) },
  { name: "matchScore 69.99999999999999999999", expected: false, br: BR(`"matchScore":69.99999999999999999999`) },
  { name: "extraction facesCount 1.00000000000000000001", expected: false, er: ER(`"facesCount":{"value":1.00000000000000000001}`) },
]

function newerIdCopy(ids: Ids, label: string, verified: boolean, sha: string) {
  return `INSERT INTO "ClientDocument" ("id","tenantId","clientId","docType","fileUrl","fileName","verified","contentSha256","createdAt")
    VALUES ('${label}_${ids.clientId}','${ids.tenantId}','${ids.clientId}','ID_COPY','','id.jpg',${verified},'${sha}',CURRENT_TIMESTAMP + interval '1 minute')`
}

function olderIdCopy(ids: Ids, label: string) {
  return `INSERT INTO "ClientDocument" ("id","tenantId","clientId","docType","fileUrl","fileName","verified","contentSha256","createdAt")
    VALUES ('${label}_${ids.clientId}','${ids.tenantId}','${ids.clientId}','ID_COPY','','id.jpg',true,'${ID_SHA}',CURRENT_TIMESTAMP - interval '1 day')`
}

async function insertSelfie(ids: Ids, selfieId: string, er: string, br: string) {
  await db.$executeRawUnsafe(
    `INSERT INTO "ClientDocument" ("id","tenantId","clientId","docType","fileUrl","fileName","verified","verifiedAt","contentSha256",
       "extractionStatus","extractionResult","validationMismatch","validationScore","biometricMatchScore","biometricLiveness","biometricVerifiedAt","biometricResult")
     VALUES ($1,$2,$3,'SELFIE','','selfie.jpg',true,CURRENT_TIMESTAMP,$4,'done',$5::jsonb,false,95,95,97,CURRENT_TIMESTAMP,$6::jsonb)`,
    selfieId, ids.tenantId, ids.clientId, "d".repeat(64), er, br,
  )
}

async function insertFailedSelfie(ids: Ids, selfieId: string, br: string, deleted: boolean) {
  await db.$executeRawUnsafe(
    `INSERT INTO "ClientDocument" ("id","tenantId","clientId","docType","fileUrl","fileName","verified","contentSha256",
       "extractionStatus","validationMismatch","biometricResult","deletedAt")
     VALUES ($1,$2,$3,'SELFIE','','selfie.jpg',false,$4,'failed',true,$5::jsonb,${deleted ? "CURRENT_TIMESTAMP" : "NULL"})`,
    selfieId, ids.tenantId, ids.clientId, "d".repeat(64), br,
  )
}

async function run(c: Case) {
  sequence += 1
  const tenantId = `t_fm_par_${sequence}_${token}`
  const clientId = `c_fm_par_${sequence}_${token}`
  const idCopyId = `fm_par_id_${sequence}_${token}`
  const ids = { tenantId, clientId, idCopyId }
  const subject = {
    id: clientId, idNumber: `FMPAR-${sequence}-${token}`, firstName: "Synthetic", lastName: "Parity",
    dateOfBirth: new Date("1990-04-05T00:00:00.000Z"),
  }
  const fingerprint = biometricSubjectFingerprint(subject)
  await db.tenant.create({ data: { id: tenantId, slug: `fm-par-${sequence}-${token}`, name: "Parity" } })
  await db.client.create({
    data: { ...subject, tenantId, reference: `CLI-FMPAR-${sequence}-${token}`, email: `fm-par-${sequence}-${token}@test.invalid`, phone: "+27820000055" },
  })
  await db.clientDocument.createMany({
    data: (["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map((docType) => ({
      id: docType === "ID_COPY" ? idCopyId : `fm_par_${docType}_${sequence}_${token}`,
      tenantId, clientId, docType, fileUrl: "", fileName: "core.pdf", verified: true, verifiedAt: new Date(),
      contentSha256: ID_SHA, createdAt: new Date(Date.now() - 60_000),
    })),
  })
  for (const statement of c.before?.(ids) ?? []) await db.$executeRawUnsafe(statement)
  const fill = (json: string) => json
    .replaceAll(FP, fingerprint)
    .replaceAll("__FPUP__", fingerprint.toUpperCase())
    .replaceAll("__SUBSTITUTE__", `substitute_${clientId}`)
    .replaceAll(ID, idCopyId)

  const selfieId = `fm_par_selfie_${sequence}_${token}`
  if (c.inPerson) {
    if (c.inPerson.older) {
      await insertFailedSelfie(ids, `${selfieId}_older`, fill(c.inPerson.older), c.inPerson.olderDeleted ?? false)
    }
    await insertFailedSelfie(ids, selfieId, fill(c.inPerson.br), c.inPerson.deleted ?? false)
    const completedAt = new Date("2026-10-12T08:00:00.000Z")
    await db.complianceRecord.create({
      data: {
        tenantId, type: "KYC_EXCEPTION", referenceId: clientId, status: "COMPLETED", completedAt,
        data: {
          kind: IN_PERSON_KYC_VERIFICATION_KIND, version: IN_PERSON_KYC_VERIFICATION_VERSION, clientId,
          idDocumentId: idCopyId, idDocumentSha256: ID_SHA, subjectFingerprint: fingerprint,
          method: "IN_PERSON_BRANCH", note: "Synthetic client attended a branch; face matched the ID photo.",
          approvedAt: completedAt.toISOString(), approvedById: "reviewer-synthetic", approvedByEmail: "reviewer@test.invalid",
        },
      },
    })
  } else {
    await insertSelfie(ids, selfieId, c.er ?? ER(), fill(c.br ?? BR()))
  }
  if (c.cols) await db.$executeRawUnsafe(`UPDATE "ClientDocument" SET ${c.cols} WHERE "id" = $1`, selfieId)

  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const app = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId, clientId, subject: client, existing: client,
  })
  const [{ ok }] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT "subject_has_composite_kyc"("tenantId","id","idNumber","firstName","lastName","dateOfBirth") AS ok
     FROM "Client" WHERE "id" = $1`,
    clientId,
  )
  return { ts: app.ok, sql: ok, tsReason: app.biometricEvidence }
}

suite("face match v2: TypeScript and SQL composite gates agree", () => {
  afterAll(async () => {
    await db.$disconnect()
  })

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const { ts, sql, tsReason } = await run(c)
    expect({ ts, sql }, `TS reason: ${tsReason}`).toEqual({ ts: c.expected, sql: c.expected })
  })

  it.each(doublePrecisionCases.map((c) => [c.name, c] as const))(
    "SQL alone refuses %s (beyond double precision)",
    async (_name, c) => {
      expect(await run(c)).toEqual(expect.objectContaining({ ts: true, sql: c.expected }))
    },
  )
})
