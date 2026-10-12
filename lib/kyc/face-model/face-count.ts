/**
 * Which detected face is compared, or why none is. Fails closed: the selfie
 * must hold exactly one face, and the ID exactly one dominant face.
 *
 * An ID-side refusal is extraction_incomplete, never
 * id_document_portrait_invalid: a detector miss is not a judgement that the
 * ID carries no real photograph (only the VLM makes that one), and since the
 * detector is deterministic it would repeat on every retry and close the
 * in-person route over a genuine but poorly scanned ID for good.
 */
import type { BiometricEvidenceFailureReason } from "@/lib/kyc/biometric-evidence"
import { ID_MAX_FACE_COUNT, ID_SECOND_FACE_MAX_AREA_RATIO, ID_SECOND_FACE_MIN_AREA_RATIO } from "./models"
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

/**
 * The largest face, if every other one is at most ID_SECOND_FACE_MAX_AREA_RATIO
 * of its area and at least ID_SECOND_FACE_MIN_AREA_RATIO (the floor both
 * evidence gates apply).
 */
export function selectIdFace(
  faces: DetectedFace[],
):
  | { ok: true; face: DetectedFace; count: number; secondFaceAreaRatio: number | null }
  | Refusal<"extraction_incomplete"> {
  if (faces.length === 0 || faces.length > ID_MAX_FACE_COUNT) {
    return { ok: false, reason: "extraction_incomplete", count: faces.length }
  }
  const [largest, ...others] = [...faces].sort((a, b) => area(b) - area(a))
  if (others.length === 0) return { ok: true, face: largest, count: 1, secondFaceAreaRatio: null }
  const secondFaceAreaRatio = area(others[0]) / area(largest)
  if (!(secondFaceAreaRatio >= ID_SECOND_FACE_MIN_AREA_RATIO && secondFaceAreaRatio <= ID_SECOND_FACE_MAX_AREA_RATIO)) {
    return { ok: false, reason: "extraction_incomplete", count: faces.length }
  }
  return { ok: true, face: largest, count: faces.length, secondFaceAreaRatio }
}

/**
 * The ID face when the image got both detector passes (it is larger than
 * 640): the 640-fit pass, and the full-resolution pass that finds the small
 * face on an A4 scan. The face-count rule must hold on EACH pass: a page
 * whose 640 pass sees only one of two comparable faces would otherwise
 * verify a selfie of either. So either pass seeing comparable faces, or more
 * than 64, refuses. Otherwise the 640 pass's dominant face is compared when
 * it found one (it also sees faces too large for the full pass), else the
 * full pass's. The recorded count is the larger of the two, with that pass's
 * second-face ratio. Without a full pass (`full` null) this is selectIdFace.
 */
export function selectIdFaceAcrossPasses(
  fit: DetectedFace[],
  full: DetectedFace[] | null,
):
  | { ok: true; face: DetectedFace; pass: "fit640" | "full"; count: number; secondFaceAreaRatio: number | null }
  | Refusal<"extraction_incomplete"> {
  const fitPick = selectIdFace(fit)
  const fullPick = full ? selectIdFace(full) : null
  const count = Math.max(fit.length, full?.length ?? 0)
  if ((!fitPick.ok && fitPick.count > 0) || (fullPick && !fullPick.ok && fullPick.count > 0)) {
    return { ok: false, reason: "extraction_incomplete", count }
  }
  const chosen = fitPick.ok ? fitPick : fullPick?.ok ? fullPick : null
  if (!chosen) return { ok: false, reason: "extraction_incomplete", count: 0 }
  const counted = fitPick.ok && fullPick?.ok && fullPick.count > fitPick.count ? fullPick : chosen
  return {
    ok: true,
    face: chosen.face,
    pass: chosen === fitPick ? "fit640" : "full",
    count: counted.count,
    secondFaceAreaRatio: counted.secondFaceAreaRatio,
  }
}
