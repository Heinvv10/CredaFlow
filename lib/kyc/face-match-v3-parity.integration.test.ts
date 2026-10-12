/**
 * TypeScript vs SQL parity for stored selfie evidence: for each case, the app's
 * composite gate (readCompositeKycState, as /review, /decide and /disburse call
 * it) and subject_has_composite_kyc must both reach the EXPECTED verdict. The
 * evidence JSON is written as raw text, so number spellings, string booleans
 * and duplicate keys reach the database exactly as written.
 *
 * Supersedes face-match-v2-parity.integration.test.ts: after migration
 * 20261011080000_face_match_v3_evidence v2 evidence no longer verifies, so
 * every case it held is here on v3 evidence (the provider-tag cases restated
 * for the v3 tag, v2 evidence added as a refusal), plus the face model's
 * fields.
 *
 *   RUN_FACE_MATCH_V3_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/face-match-v3-parity.integration.test.ts
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

const RUN = process.env.RUN_FACE_MATCH_V3_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const ID_SHA = "a".repeat(64)
let sequence = 0

// Placeholders substituted per case.
const FP = "__FP__"
const ID = "__ID__"
// The face model's evidence (lib/kyc/face-model/evidence.ts), written raw.
const FM = (change = "") =>
  `{"detector":"face_detection_yunet_2023mar",` +
  `"detectorSha256":"8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",` +
  `"recognizer":"face_recognition_sface_2021dec",` +
  `"recognizerSha256":"0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",` +
  `"selfieFaceCount":1,"idFaceCount":1,"idSecondFaceAreaRatio":null,"idDetectPass":"fit640",` +
  `"idInterOcularPx":100,"selfieInterOcularPx":240,"idGeometryMargin":0.4,"selfieGeometryMargin":0.5,` +
  `"idSharpness":1100,"selfieSharpness":1200,"similarity":0.71,` +
  `"threshold":0.363,"samePerson":true${change ? "," + change : ""}}`
const BR = (change = "") =>
  `{"ok":true,"verified":true,"provider":"vlm-face-match-v3","faceModel":${FM()},"matchScore":95,"livenessScore":97,` +
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
  /** Also record an in-person attestation over the seeded ID copy. */
  attest?: boolean
  /** The attestation was completed a day BEFORE the selfie (default: an hour after). */
  attestBefore?: boolean
  /** The selfie was captured at the attestation's exact completion instant. */
  attestAtSelfie?: boolean
}
type Ids = { tenantId: string; clientId: string; idCopyId: string }

// JSON duplicate keys: the later one wins in both JSON.parse and jsonb.
const cases: Case[] = [
  { name: "control: consistent v3 pass", expected: true },
  { name: "ok is the string \"true\"", expected: false, br: BR(`"ok":"true"`) },
  { name: "verified is the string \"true\"", expected: false, br: BR(`"verified":"true"`) },
  { name: "ok and verified both strings", expected: false, br: BR(`"ok":"true","verified":"true"`) },
  { name: "simulated is the string \"true\"", expected: false, br: BR(`"simulated":"true"`) },
  { name: "simulated is 1", expected: false, br: BR(`"simulated":1`) },
  { name: "simulated is null", expected: false, br: BR(`"simulated":null`) },
  { name: "simulated is false", expected: true, br: BR(`"simulated":false`) },
  { name: "provider mixed case", expected: false, br: BR(`"provider":"VLM-Face-Match-V3"`) },
  { name: "provider with a trailing space", expected: false, br: BR(`"provider":"vlm-face-match-v3 "`) },
  { name: "provider as an array", expected: false, br: BR(`"provider":["vlm-face-match-v3"]`) },
  { name: "provider v1 with an extra providerV2 tag", expected: false, br: BR(`"provider":"vlm-face-match-v1","providerV2":"vlm-face-match-v2"`) },
  { name: "provider v2 with an extra providerV3 tag", expected: false, br: BR(`"provider":"vlm-face-match-v2","providerV3":"vlm-face-match-v3"`) },
  { name: "v2 evidence: the v2 tag, the face model present", expected: false, br: BR(`"provider":"vlm-face-match-v2"`) },
  { name: "v2-shaped evidence: the v3 tag, no face model", expected: false, br: BR().replace(`"faceModel":${FM()},`, "") },
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

  // The face model's evidence: the same-person decision.
  { name: "face model: similarity exactly at the threshold", expected: true, br: BR(`"faceModel":${FM(`"similarity":0.363`)}`) },
  { name: "face model: similarity 3.63e-1", expected: true, br: BR(`"faceModel":${FM(`"similarity":3.63e-1`)}`) },
  { name: "face model: similarity exactly 1", expected: true, br: BR(`"faceModel":${FM(`"similarity":1`)}`) },
  { name: "face model: similarity just below the threshold", expected: false, br: BR(`"faceModel":${FM(`"similarity":0.36299999999999993`)}`) },
  { name: "face model: similarity 0.2 with samePerson true", expected: false, br: BR(`"faceModel":${FM(`"similarity":0.2`)}`) },
  { name: "face model: similarity 1.0001", expected: false, br: BR(`"faceModel":${FM(`"similarity":1.0001`)}`) },
  { name: "face model: similarity a string", expected: false, br: BR(`"faceModel":${FM(`"similarity":"0.71"`)}`) },
  { name: "face model: similarity null", expected: false, br: BR(`"faceModel":${FM(`"similarity":null`)}`) },
  { name: "face model: samePerson false", expected: false, br: BR(`"faceModel":${FM(`"samePerson":false`)}`) },
  { name: "face model: samePerson the string true", expected: false, br: BR(`"faceModel":${FM(`"samePerson":"true"`)}`) },
  { name: "face model: threshold 0.3630", expected: true, br: BR(`"faceModel":${FM(`"threshold":0.3630`)}`) },
  { name: "face model: threshold lowered to 0.2", expected: false, br: BR(`"faceModel":${FM(`"threshold":0.2,"similarity":0.3`)}`) },
  { name: "face model: threshold a string", expected: false, br: BR(`"faceModel":${FM(`"threshold":"0.363"`)}`) },
  { name: "face model: detector checksum upper case", expected: false, br: BR(`"faceModel":${FM(`"detectorSha256":"8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4"`)}`) },
  { name: "face model: recognizer checksum of another file", expected: false, br: BR(`"faceModel":${FM(`"recognizerSha256":"${"f".repeat(64)}"`)}`) },
  { name: "face model: the int8 detector", expected: false, br: BR(`"faceModel":${FM(`"detector":"face_detection_yunet_2023mar_int8"`)}`) },
  { name: "face model: selfieFaceCount 1.0", expected: true, br: BR(`"faceModel":${FM(`"selfieFaceCount":1.0`)}`) },
  { name: "face model: selfieFaceCount the string 1", expected: false, br: BR(`"faceModel":${FM(`"selfieFaceCount":"1"`)}`) },
  { name: "face model: selfieFaceCount 2", expected: false, br: BR(`"faceModel":${FM(`"selfieFaceCount":2`)}`) },
  { name: "face model: idFaceCount 0", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":0`)}`) },
  { name: "face model: idFaceCount 1.5", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":1.5`)}`) },
  { name: "face model: idFaceCount the string 1", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":"1"`)}`) },
  { name: "face model: one ID face carrying a ratio", expected: false, br: BR(`"faceModel":${FM(`"idSecondFaceAreaRatio":0.1`)}`) },
  { name: "face model: one ID face, the ratio absent", expected: false, br: BR(`"faceModel":${FM().replace(`"idSecondFaceAreaRatio":null,`, "")}`) },
  { name: "face model: a ghost face at 0.1", expected: true, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":0.1`)}`) },
  { name: "face model: a second face at exactly half", expected: true, br: BR(`"faceModel":${FM(`"idFaceCount":3,"idSecondFaceAreaRatio":0.5`)}`) },
  { name: "face model: two comparable ID faces", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":0.51`)}`) },
  { name: "face model: two ID faces, no ratio", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":2`)}`) },
  { name: "face model: a string ratio", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":"0.1"`)}`) },
  { name: "face model: an array", expected: false, br: BR(`"faceModel":[${FM()}]`) },
  { name: "face model: the string of the evidence", expected: false, br: BR(`"faceModel":${JSON.stringify(FM())}`) },
  { name: "face model: duplicate samePerson, false then true", expected: true, br: BR(`"faceModel":${FM(`"samePerson":false,"samePerson":true`)}`) },
  { name: "face model: duplicate similarity, passing then failing", expected: false, br: BR(`"faceModel":${FM(`"similarity":0.9,"similarity":0.1`)}`) },
  { name: "face model: VLM uncertain beside a passing model", expected: false, br: BR(`"samePerson":"uncertain","faceMatch":false`) },
  // Count bounds (the breaker: 1e400 passed SQL and breaks Prisma reads).
  { name: "face model: idFaceCount 64 with a small second face", expected: true, br: BR(`"faceModel":${FM(`"idFaceCount":64,"idSecondFaceAreaRatio":0.01`)}`) },
  { name: "face model: idFaceCount 65", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":65,"idSecondFaceAreaRatio":0.01`)}`) },
  { name: "face model: a second-face ratio of 0", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":0`)}`) },
  // JS parses 1e-400 as 0 and refused it; SQL read a positive numeric and
  // accepted it. The 1e-9 floor makes both refuse.
  { name: "face model: a second-face ratio of 1e-400", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":1e-400`)}`) },
  { name: "face model: a second-face ratio exactly 1e-9", expected: true, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":1e-9`)}`) },
  { name: "face model: a second-face ratio of 9e-10", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":9e-10`)}`) },
  // Which detector pass found the ID face: an enum, compared as a JSON string.
  { name: "face model: found on the full-resolution pass", expected: true, br: BR(`"faceModel":${FM(`"idDetectPass":"full"`)}`) },
  { name: "face model: an unknown detector pass", expected: false, br: BR(`"faceModel":${FM(`"idDetectPass":"tiles"`)}`) },
  { name: "face model: a detector pass in upper case", expected: false, br: BR(`"faceModel":${FM(`"idDetectPass":"FULL"`)}`) },
  { name: "face model: a detector pass in an array", expected: false, br: BR(`"faceModel":${FM(`"idDetectPass":["full"]`)}`) },
  { name: "face model: a detector pass as a number", expected: false, br: BR(`"faceModel":${FM(`"idDetectPass":640`)}`) },
  { name: "face model: no detector pass", expected: false, br: BR(`"faceModel":${FM().replace(`"idDetectPass":"fit640",`, "")}`) },
  // The quality floors and ceilings on each compared face.
  { name: "face model: eyes exactly 24 px apart on both", expected: true, br: BR(`"faceModel":${FM(`"idInterOcularPx":24,"selfieInterOcularPx":24`)}`) },
  { name: "face model: ID eyes 23.9 px apart", expected: false, br: BR(`"faceModel":${FM(`"idInterOcularPx":23.9`)}`) },
  { name: "face model: selfie eyes 23.9 px apart", expected: false, br: BR(`"faceModel":${FM(`"selfieInterOcularPx":23.9`)}`) },
  { name: "face model: eye distance a string", expected: false, br: BR(`"faceModel":${FM(`"selfieInterOcularPx":"240"`)}`) },
  { name: "face model: geometry margins exactly 0.15", expected: true, br: BR(`"faceModel":${FM(`"idGeometryMargin":0.15,"selfieGeometryMargin":0.15`)}`) },
  { name: "face model: ID geometry margin 0.149", expected: false, br: BR(`"faceModel":${FM(`"idGeometryMargin":0.149`)}`) },
  { name: "face model: selfie geometry margin above 1", expected: false, br: BR(`"faceModel":${FM(`"selfieGeometryMargin":1.01`)}`) },
  { name: "face model: sharpness exactly 100 on both", expected: true, br: BR(`"faceModel":${FM(`"idSharpness":100,"selfieSharpness":100`)}`) },
  { name: "face model: ID sharpness 99.9", expected: false, br: BR(`"faceModel":${FM(`"idSharpness":99.9`)}`) },
  { name: "face model: selfie sharpness 0", expected: false, br: BR(`"faceModel":${FM(`"selfieSharpness":0`)}`) },
  { name: "face model: sharpness 3e6", expected: false, br: BR(`"faceModel":${FM(`"idSharpness":3e6`)}`) },
  { name: "face model: no selfie sharpness", expected: false, br: BR(`"faceModel":${FM().replace(`"selfieSharpness":1200,`, "")}`) },

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
  { name: "extraction vlmUnavailable true beside a v3 verdict", expected: true, er: `{"vlmUnavailable":true}` },
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
  // A PASSED selfie blocks the in-person route unless the ID copy it names is
  // no longer a non-deleted, unrejected ID copy of this client.
  ...([
    ["a newer copy awaiting review", false, (ids: Ids) => [newerIdCopy(ids, "awaiting", false, "b".repeat(64))], "awaiting"],
    ["a newer copy staff rejected", true, (ids: Ids) => [newerIdCopy(ids, "rejected", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "verificationRejectedAt" = CURRENT_TIMESTAMP, "verificationRejectedById" = 'officer-synthetic'
      WHERE "id" = 'rejected_${ids.clientId}'`], "rejected"],
    ["a newer copy rejected by a named reviewer only", true, (ids: Ids) => [newerIdCopy(ids, "named", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "verificationRejectedById" = 'officer-synthetic' WHERE "id" = 'named_${ids.clientId}'`], "named"],
    ["a newer copy rejected with a timestamp only", true, (ids: Ids) => [newerIdCopy(ids, "stamped", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "verificationRejectedAt" = CURRENT_TIMESTAMP WHERE "id" = 'stamped_${ids.clientId}'`], "stamped"],
    ["a copy since deleted", true, (ids: Ids) => [newerIdCopy(ids, "deleted", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = 'deleted_${ids.clientId}'`], "deleted"],
    ["a copy that does not exist", true, () => [], "gone"],
    ["an older verified copy, superseded", false, (ids: Ids) => [olderIdCopy(ids, "superseded")], "superseded"],
  ] as const).map(([label, expected, before, prefix]): Case => ({
    name: `in person: a passed selfie bound to ${label}`,
    expected,
    attest: true,
    before,
    br: BR(`"idDocumentId":"${prefix}___CLIENT__","idDocumentSha256":"${prefix === "superseded" ? ID_SHA : "b".repeat(64)}"`),
  })),
  // Processing governs whatever the row's stale evidence names.
  { name: "in person: an attempt still processing keeps blocking, even naming a rejected copy", expected: false, attest: true,
    before: (ids) => [newerIdCopy(ids, "gone_by", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "verificationRejectedAt" = CURRENT_TIMESTAMP, "verificationRejectedById" = 'officer-synthetic' WHERE "id" = 'gone_by_${ids.clientId}'`],
    br: BR(`"idDocumentId":"gone_by___CLIENT__","idDocumentSha256":"${"b".repeat(64)}"`),
    cols: `"extractionStatus" = 'processing'` },
  // Released only for an attestation completed AFTER the selfie was captured.
  { name: "in person: a passed selfie bound to a rejected copy still blocks an earlier attestation", expected: false,
    attest: true, attestBefore: true,
    before: (ids) => [newerIdCopy(ids, "late_rejected", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "verificationRejectedAt" = CURRENT_TIMESTAMP, "verificationRejectedById" = 'officer-synthetic' WHERE "id" = 'late_rejected_${ids.clientId}'`],
    br: BR(`"idDocumentId":"late_rejected___CLIENT__","idDocumentSha256":"${"b".repeat(64)}"`) },
  { name: "in person: a passed selfie bound to a rejected copy still blocks an attestation at the same instant", expected: false,
    attest: true, attestAtSelfie: true,
    before: (ids) => [newerIdCopy(ids, "same_instant", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "verificationRejectedAt" = CURRENT_TIMESTAMP, "verificationRejectedById" = 'officer-synthetic' WHERE "id" = 'same_instant_${ids.clientId}'`],
    br: BR(`"idDocumentId":"same_instant___CLIENT__","idDocumentSha256":"${"b".repeat(64)}"`) },
  { name: "in person: a passed selfie bound to a deleted copy still blocks an earlier attestation", expected: false,
    attest: true, attestBefore: true,
    before: (ids) => [newerIdCopy(ids, "late_deleted", false, "b".repeat(64)), `UPDATE "ClientDocument" SET "deletedAt" = CURRENT_TIMESTAMP WHERE "id" = 'late_deleted_${ids.clientId}'`],
    br: BR(`"idDocumentId":"late_deleted___CLIENT__","idDocumentSha256":"${"b".repeat(64)}"`) },
  { name: "in person: a passed selfie naming no ID copy keeps blocking", expected: false, attest: true,
    br: BR().replace(`"idDocumentId":"${ID}",`, "").replace(`"idDocumentSha256":"${ID_SHA}",`, "") },
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
  { name: "face model similarity 0.36299999999999999999", expected: false, br: BR(`"faceModel":${FM(`"similarity":0.36299999999999999999`)}`) },
  { name: "face model second-face ratio 0.50000000000000000001", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":2,"idSecondFaceAreaRatio":0.50000000000000000001`)}`) },
]

/**
 * Numbers beyond a double: jsonb stores them, Prisma cannot read them back
 * (the app's composite read throws, which refuses), and SQL must refuse too.
 */
const beyondDoubleCases: Case[] = [
  { name: "face model idFaceCount 1e400", expected: false, br: BR(`"faceModel":${FM(`"idFaceCount":1e400,"idSecondFaceAreaRatio":0.1`)}`) },
  { name: "face model eye distance 1e400", expected: false, br: BR(`"faceModel":${FM(`"idInterOcularPx":1e400`)}`) },
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
    .replaceAll("__CLIENT__", clientId)

  const selfieId = `fm_par_selfie_${sequence}_${token}`
  if (c.inPerson) {
    if (c.inPerson.older) {
      await insertFailedSelfie(ids, `${selfieId}_older`, fill(c.inPerson.older), c.inPerson.olderDeleted ?? false)
    }
    await insertFailedSelfie(ids, selfieId, fill(c.inPerson.br), c.inPerson.deleted ?? false)
  } else {
    await insertSelfie(ids, selfieId, c.er ?? ER(), fill(c.br ?? BR()))
  }
  if (c.inPerson || c.attest) {
    const completedAt = new Date(Date.now() + (c.attestBefore ? -86_400_000 : 3_600_000))
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
  }
  if (c.attestAtSelfie) {
    const [{ completedAt }] = await db.$queryRawUnsafe<Array<{ completedAt: Date }>>(
      `SELECT "completedAt" FROM "ComplianceRecord" WHERE "referenceId" = $1`, clientId,
    )
    await db.$executeRawUnsafe(`UPDATE "ClientDocument" SET "createdAt" = $1 WHERE "id" = $2`, completedAt, selfieId)
  }
  if (c.cols) await db.$executeRawUnsafe(`UPDATE "ClientDocument" SET ${c.cols} WHERE "id" = $1`, selfieId)

  const [{ ok }] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT "subject_has_composite_kyc"("tenantId","id","idNumber","firstName","lastName","dateOfBirth") AS ok
     FROM "Client" WHERE "id" = $1`,
    clientId,
  )
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const app = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId, clientId, subject: client, existing: client,
  }).catch(() => null)
  return app === null
    ? { ts: "read failed" as const, sql: ok, tsReason: null }
    : { ts: app.ok, sql: ok, tsReason: app.biometricEvidence }
}

suite("face match v3: TypeScript and SQL composite gates agree", () => {
  afterAll(async () => {
    await db.$disconnect()
  })

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const { ts, sql, tsReason } = await run(c)
    expect({ ts, sql }, `TS reason: ${tsReason}`).toEqual({ ts: c.expected, sql: c.expected })
  })

  it.each(beyondDoubleCases.map((c) => [c.name, c] as const))(
    "SQL refuses, and the app cannot read, %s",
    async (_name, c) => {
      expect(await run(c)).toEqual(expect.objectContaining({ ts: "read failed", sql: false }))
    },
  )

  it.each(doublePrecisionCases.map((c) => [c.name, c] as const))(
    "SQL alone refuses %s (beyond double precision)",
    async (_name, c) => {
      expect(await run(c)).toEqual(expect.objectContaining({ ts: true, sql: c.expected }))
    },
  )
})
