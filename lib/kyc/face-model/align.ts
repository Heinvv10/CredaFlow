/**
 * SFace (OpenCV Zoo face_recognition_sface_2021dec) input and matching, as
 * plain typed-array math: the 5-point similarity alignment to the 112x112
 * template and the cosine similarity between two embeddings.
 *
 * Follows cv::FaceRecognizerSF (opencv/modules/objdetect/src/face_recognize.cpp):
 * alignCrop's Umeyama transform onto the ArcFace landmarks, a bilinear warp
 * with a zero border, RGB planes of raw 0-255 values, and match() with
 * FR_COSINE.
 */
import type { RgbImage } from "./yunet"

export const SFACE_INPUT_SIZE = 112

/** Where the five YuNet landmarks sit in an aligned face (alignCrop's dst). */
export const SFACE_LANDMARK_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
] as const
// The template mean as OpenCV hard-codes it.
const TEMPLATE_MEAN = [56.0262, 71.9008] as const

/**
 * The 2x3 matrix [a, b, tx, c, d, ty] taking image coordinates onto the
 * template: rotation, uniform scale and translation, never a reflection.
 *
 * OpenCV reaches it through an SVD of the 2x2 covariance; for two dimensions
 * the same least-squares answer is the closed form below (the rotation angle
 * is atan2 of the covariance's antisymmetric part over its trace).
 */
export function similarityTransform(landmarks: number[]): number[] {
  if (landmarks.length !== 10 || !landmarks.every(Number.isFinite)) {
    throw new Error("Face alignment needs five finite landmarks")
  }
  let meanX = 0
  let meanY = 0
  for (let i = 0; i < 5; i++) {
    meanX += landmarks[2 * i] / 5
    meanY += landmarks[2 * i + 1] / 5
  }
  let trace = 0
  let skew = 0
  let variance = 0
  for (let i = 0; i < 5; i++) {
    const sx = landmarks[2 * i] - meanX
    const sy = landmarks[2 * i + 1] - meanY
    const dx = SFACE_LANDMARK_TEMPLATE[i][0] - TEMPLATE_MEAN[0]
    const dy = SFACE_LANDMARK_TEMPLATE[i][1] - TEMPLATE_MEAN[1]
    trace += (dx * sx + dy * sy) / 5
    skew += (dy * sx - dx * sy) / 5
    variance += (sx * sx + sy * sy) / 5
  }
  const magnitude = Math.hypot(trace, skew)
  if (!(variance > 0) || !(magnitude > 0)) {
    throw new Error("Face landmarks are degenerate")
  }
  // scale * cos and scale * sin of the rotation.
  const a = trace / variance
  const c = skew / variance
  return [a, -c, TEMPLATE_MEAN[0] - (a * meanX - c * meanY), c, a, TEMPLATE_MEAN[1] - (c * meanX + a * meanY)]
}

/**
 * The 1x3x112x112 SFace input: the face warped onto the template (bilinear,
 * zero outside the image, like cv::warpAffine's defaults).
 */
export function alignedFaceTensor(image: RgbImage, landmarks: number[]): Float32Array {
  const [a, b, tx, c, d, ty] = similarityTransform(landmarks)
  const det = a * d - b * c
  const { data, width, height } = image
  const plane = SFACE_INPUT_SIZE * SFACE_INPUT_SIZE
  const tensor = new Float32Array(3 * plane)
  const pixel = (x: number, y: number, channel: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 3 + channel]
  for (let y = 0; y < SFACE_INPUT_SIZE; y++) {
    for (let x = 0; x < SFACE_INPUT_SIZE; x++) {
      // The inverse transform: where this template pixel comes from.
      const sourceX = (d * (x - tx) - b * (y - ty)) / det
      const sourceY = (a * (y - ty) - c * (x - tx)) / det
      const x0 = Math.floor(sourceX)
      const y0 = Math.floor(sourceY)
      const fx = sourceX - x0
      const fy = sourceY - y0
      for (let channel = 0; channel < 3; channel++) {
        tensor[channel * plane + y * SFACE_INPUT_SIZE + x] =
          (1 - fy) * ((1 - fx) * pixel(x0, y0, channel) + fx * pixel(x0 + 1, y0, channel)) +
          fy * ((1 - fx) * pixel(x0, y0 + 1, channel) + fx * pixel(x0 + 1, y0 + 1, channel))
      }
    }
  }
  return tensor
}

/**
 * Cosine similarity in -1..1, or NaN when it is not defined (empty, unequal
 * lengths, a zero or non-finite vector). Callers must treat NaN as a refusal.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return Number.NaN
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const cosine = dot / Math.sqrt(normA * normB)
  // Rounding can land a hair outside the range; anything else stays NaN.
  return Number.isFinite(cosine) ? Math.max(-1, Math.min(1, cosine)) : Number.NaN
}
