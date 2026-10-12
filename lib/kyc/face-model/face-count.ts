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
import { overlap, YUNET_NMS_THRESHOLD, type DetectedFace } from "./yunet"

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
 * face on an A4 scan. Their detections, all in source pixels, are MERGED
 * first: a full-pass box that overlaps a 640-pass box by more than the NMS
 * IoU (0.3) is the same face, and the 640 pass's box is kept (it also sees
 * faces too large for the full pass). Counting each pass on its own let two
 * comparable faces, one seen only by each pass, look like one face to both.
 * selectIdFace then applies the comparable-faces rule, the 64 cap and the
 * 1e-9 floor to the merged list, and the count, the ratio and the compared
 * face all come from it. Without a full pass (`full` null) this is
 * selectIdFace.
 */
export function selectIdFaceAcrossPasses(
  fit: DetectedFace[],
  full: DetectedFace[] | null,
):
  | { ok: true; face: DetectedFace; pass: "fit640" | "full"; count: number; secondFaceAreaRatio: number | null }
  | Refusal<"extraction_incomplete"> {
  const merged: Array<{ face: DetectedFace; pass: "fit640" | "full" }> = fit.map((face) => ({ face, pass: "fit640" }))
  for (const face of full ?? []) {
    if (merged.every((kept) => overlap(kept.face, face) <= YUNET_NMS_THRESHOLD)) merged.push({ face, pass: "full" })
  }
  const pick = selectIdFace(merged.map((m) => m.face))
  if (!pick.ok) return pick
  return { ...pick, pass: merged.find((m) => m.face === pick.face)!.pass }
}
