/**
 * Which detected face is compared, or why none is. Fails closed: the selfie
 * must hold exactly one face, and the ID exactly one dominant face.
 */
import type { BiometricEvidenceFailureReason } from "@/lib/kyc/biometric-evidence"
import { ID_SECOND_FACE_MAX_AREA_RATIO } from "./models"
import type { DetectedFace } from "./yunet"

type Refusal<R extends BiometricEvidenceFailureReason> = { ok: false; reason: R; count: number }

export function selectSelfieFace(
  faces: DetectedFace[],
): { ok: true; face: DetectedFace; count: 1 } | Refusal<"face_not_detected" | "face_count_invalid"> {
  if (faces.length === 0) return { ok: false, reason: "face_not_detected", count: 0 }
  if (faces.length > 1) return { ok: false, reason: "face_count_invalid", count: faces.length }
  return { ok: true, face: faces[0], count: 1 }
}

const area = (face: DetectedFace) => face.width * face.height

/** The largest face, if every other one is at most ID_SECOND_FACE_MAX_AREA_RATIO of its area. */
export function selectIdFace(
  faces: DetectedFace[],
):
  | { ok: true; face: DetectedFace; count: number; secondFaceAreaRatio: number | null }
  | Refusal<"id_document_portrait_invalid"> {
  if (faces.length === 0) return { ok: false, reason: "id_document_portrait_invalid", count: 0 }
  const [largest, ...others] = [...faces].sort((a, b) => area(b) - area(a))
  if (others.length === 0) return { ok: true, face: largest, count: 1, secondFaceAreaRatio: null }
  const secondFaceAreaRatio = area(others[0]) / area(largest)
  if (!(secondFaceAreaRatio <= ID_SECOND_FACE_MAX_AREA_RATIO)) {
    return { ok: false, reason: "id_document_portrait_invalid", count: faces.length }
  }
  return { ok: true, face: largest, count: faces.length, secondFaceAreaRatio }
}
