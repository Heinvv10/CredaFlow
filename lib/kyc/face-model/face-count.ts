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
 * face on an A4 scan. Three checks, all of which must be clean:
 *   - each pass on its own (selectIdFace: comparable faces, the 64 cap, the
 *     1e-9 floor). A large face only one pass sees can make two comparable
 *     faces only the other pass sees look like ghosts once merged;
 *   - the merged list: the detections, all in source pixels, merged with NMS
 *     at IoU 0.3, the 640 pass's box kept for a duplicate (it also sees faces
 *     too large for the full pass). Two comparable faces, one seen only by
 *     each pass, are one face to each pass and two here.
 * Only then is the merged list's dominant face compared, with its count and
 * second-face ratio; `pass` names the pass that produced the compared box.
 * Without a full pass (`full` null) this is selectIdFace.
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
  const count = Math.max(fit.length, full?.length ?? 0, merged.length)
  const refuses = (faces: DetectedFace[]) => {
    const pick = selectIdFace(faces)
    return !pick.ok && pick.count > 0
  }
  if (refuses(fit) || (full !== null && refuses(full))) return { ok: false, reason: "extraction_incomplete", count }
  const pick = selectIdFace(merged.map((m) => m.face))
  if (!pick.ok) return { ok: false, reason: "extraction_incomplete", count: pick.count === 0 ? 0 : count }
  return { ...pick, pass: merged.find((m) => m.face === pick.face)!.pass }
}
