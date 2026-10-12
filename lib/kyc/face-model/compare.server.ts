/**
 * The same-person decision: YuNet finds the faces, SFace embeds the one on
 * the ID and the one in the selfie, and the cosine similarity of the two
 * embeddings decides against FACE_SIMILARITY_THRESHOLD.
 *
 * Never throws and never passes by default. A model that is missing, fails its
 * checksum or will not load, an image that will not decode, inference that
 * throws or overruns, a face count outside the rule, or a similarity that is
 * not a number all come back as a refusal. ID-side refusals are named ahead of
 * selfie-side ones, as in the VLM gates. None of them is
 * id_document_portrait_invalid: that reason says the ID has no real
 * photograph, closes the in-person route over it, and only the VLM's own
 * judgement of the portrait may record it (see face-count.ts).
 */
import sharp from "sharp"
import type { BiometricEvidenceFailureReason } from "@/lib/kyc/biometric-evidence"
import { CANONICAL_IMAGE_MAX_EDGE_PX, MAX_INPUT_PIXELS } from "@/lib/kyc/biometric-image.server"
import { alignedFaceTensor, cosineSimilarity } from "./align"
import type { FaceModelEvidence } from "./evidence"
import { selectIdFace, selectSelfieFace } from "./face-count"
import {
  FACE_MODELS,
  FACE_SIMILARITY_THRESHOLD,
  MIN_ALIGNED_CROP_SHARPNESS,
  MIN_INTER_OCULAR_PX,
  MIN_LANDMARK_GEOMETRY_MARGIN,
} from "./models"
import { alignedCropSharpness, interOcularDistance, landmarkGeometryMargin } from "./quality"
import { loadFaceModelRuntime, type FaceModelRuntime } from "./runtime.server"
import { YUNET_INPUT_SIZE, decodeYunetOutputs, yunetInputTensor, type DetectedFace, type RgbImage } from "./yunet"

/** Covers loading the models too; a cold load measured well under a second. */
export const FACE_COMPARISON_TIMEOUT_MS = 30_000
// Enough for alignment (the compared face is 112px) without decoding a
// 50-megapixel upload at full size; the canonical image is already capped
// at the same edge, so both judges see the same resolution.
const MAX_DECODE_EDGE = CANONICAL_IMAGE_MAX_EDGE_PX

export type FaceComparisonRejection = {
  reason: Extract<
    BiometricEvidenceFailureReason,
    | "extraction_incomplete"
    | "face_not_detected"
    | "face_count_invalid"
    | "match_score_below_threshold"
  >
  message: string
}

export type FaceComparison =
  /** A similarity was computed; `rejection` is set when it is below the threshold. */
  | { ok: true; evidence: FaceModelEvidence; rejection: FaceComparisonRejection | null }
  | {
      ok: false
      rejection: FaceComparisonRejection
      idFaceCount: number | null
      selfieFaceCount: number | null
    }

type ImageInput = { fileBuffer: Buffer; mimeType: string }

export function isSamePerson(similarity: number): boolean {
  return similarity >= FACE_SIMILARITY_THRESHOLD
}

/** Interleaved RGB, EXIF orientation applied, transparency on white, long edge at most 2048. */
export async function decodeImage(bytes: Buffer): Promise<RgbImage> {
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(MAX_DECODE_EDGE, MAX_DECODE_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) throw new Error(`decoded ${info.channels} channels, expected 3`)
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height }
}

async function detectFaces(image: RgbImage, runtime: FaceModelRuntime): Promise<DetectedFace[]> {
  const scale = Math.min(1, YUNET_INPUT_SIZE / image.width, YUNET_INPUT_SIZE / image.height)
  let input = image
  if (scale < 1) {
    const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
      .resize(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)), { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true })
    input = { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height }
  }
  return decodeYunetOutputs(await runtime.detect(yunetInputTensor(input)), scale)
}

type Counts = { idFaceCount: number | null; selfieFaceCount: number | null }

function refuse(reason: FaceComparisonRejection["reason"], message: string, counts: Counts): FaceComparison {
  return { ok: false, rejection: { reason, message }, ...counts }
}

/**
 * The aligned crop and its measures, or why the face is not usable. Every
 * refusal is extraction_incomplete: a detector or quality miss says nothing
 * about whether the document carries a real photograph.
 */
function usableFace(image: RgbImage, face: DetectedFace, where: string) {
  const interOcularPx = interOcularDistance(face.landmarks)
  if (!(interOcularPx >= MIN_INTER_OCULAR_PX)) return { ok: false as const, refusal: `The face ${where} is too small for the face comparison` }
  const geometryMargin = landmarkGeometryMargin(face.landmarks)
  if (!(geometryMargin >= MIN_LANDMARK_GEOMETRY_MARGIN)) return { ok: false as const, refusal: `The face ${where} does not have the layout of a face` }
  const crop = alignedFaceTensor(image, face.landmarks)
  const sharpness = alignedCropSharpness(crop)
  if (!(sharpness >= MIN_ALIGNED_CROP_SHARPNESS)) return { ok: false as const, refusal: `The face ${where} is too blurred for the face comparison` }
  return { ok: true as const, crop, interOcularPx, geometryMargin, sharpness }
}

async function compare(id: ImageInput, selfie: ImageInput, loadRuntime: () => Promise<FaceModelRuntime>): Promise<FaceComparison> {
  let counts: Counts = { idFaceCount: null, selfieFaceCount: null }
  let runtime: FaceModelRuntime
  try {
    runtime = await loadRuntime()
  } catch (error) {
    console.error("Face comparison models unavailable:", error)
    return refuse("extraction_incomplete", "Face comparison could not run: the face models are unavailable", counts)
  }
  const idImage = await decodeImage(id.fileBuffer).catch(() => null)
  if (!idImage) {
    return refuse("extraction_incomplete", "The ID document image could not be read for the face comparison", counts)
  }
  const selfieImage = await decodeImage(selfie.fileBuffer).catch(() => null)
  if (!selfieImage) {
    return refuse("extraction_incomplete", "The selfie image could not be read for the face comparison", counts)
  }
  try {
    const idFaces = await detectFaces(idImage, runtime)
    const selfieFaces = await detectFaces(selfieImage, runtime)
    counts = { idFaceCount: idFaces.length, selfieFaceCount: selfieFaces.length }
    const idFace = selectIdFace(idFaces)
    if (!idFace.ok) {
      return refuse(idFace.reason, idFace.count === 0
        ? "No face found in the ID document photograph by the face comparison"
        : `The ID document shows ${idFace.count} faces of comparable size; the face comparison cannot tell whose it is`, counts)
    }
    const selfieFace = selectSelfieFace(selfieFaces)
    if (!selfieFace.ok) {
      return refuse(selfieFace.reason, selfieFace.count === 0
        ? "No face found in the selfie by the face comparison"
        : `The selfie shows ${selfieFace.count} faces; the face comparison needs exactly one`, counts)
    }
    const id = usableFace(idImage, idFace.face, "on the ID document")
    if (!id.ok) return refuse("extraction_incomplete", id.refusal, counts)
    const self = usableFace(selfieImage, selfieFace.face, "in the selfie")
    if (!self.ok) return refuse("extraction_incomplete", self.refusal, counts)
    const idEmbedding = await runtime.embed(id.crop)
    const selfieEmbedding = await runtime.embed(self.crop)
    const similarity = cosineSimilarity(idEmbedding, selfieEmbedding)
    if (!Number.isFinite(similarity)) {
      return refuse("extraction_incomplete", "Face comparison produced no valid similarity", counts)
    }
    const samePerson = isSamePerson(similarity)
    return {
      ok: true,
      evidence: {
        detector: FACE_MODELS.detector.name,
        detectorSha256: FACE_MODELS.detector.sha256,
        recognizer: FACE_MODELS.recognizer.name,
        recognizerSha256: FACE_MODELS.recognizer.sha256,
        selfieFaceCount: selfieFace.count,
        idFaceCount: idFace.count,
        idSecondFaceAreaRatio: idFace.secondFaceAreaRatio,
        idInterOcularPx: id.interOcularPx,
        selfieInterOcularPx: self.interOcularPx,
        idGeometryMargin: id.geometryMargin,
        selfieGeometryMargin: self.geometryMargin,
        idSharpness: id.sharpness,
        selfieSharpness: self.sharpness,
        similarity,
        threshold: FACE_SIMILARITY_THRESHOLD,
        samePerson,
      },
      rejection: samePerson
        ? null
        : { reason: "match_score_below_threshold", message: "Face comparison similarity below threshold" },
    }
  } catch (error) {
    console.error("Face comparison failed:", error)
    return refuse("extraction_incomplete", "Face comparison could not run", counts)
  }
}

export async function compareFaces(
  id: ImageInput,
  selfie: ImageInput,
  deps: { loadRuntime: () => Promise<FaceModelRuntime>; timeoutMs: number } = {
    loadRuntime: loadFaceModelRuntime,
    timeoutMs: FACE_COMPARISON_TIMEOUT_MS,
  },
): Promise<FaceComparison> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<FaceComparison>((resolve) => {
    timer = setTimeout(() => resolve(refuse("extraction_incomplete", "Face comparison timed out", {
      idFaceCount: null,
      selfieFaceCount: null,
    })), deps.timeoutMs)
  })
  try {
    return await Promise.race([compare(id, selfie, deps.loadRuntime), timeout])
  } finally {
    clearTimeout(timer)
  }
}
