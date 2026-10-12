/**
 * Model-side checks on a detected face that do not depend on the VLM. SFace
 * embeds anything it is handed: two different drawn faces YuNet happened to
 * detect, or face-free crops, can score far above the threshold. These
 * measures, with floors in models.ts, refuse what is plainly not a usable
 * real face before any similarity is trusted. They narrow the gap; they do
 * not close it (docs/FACE-COMPARISON-MODEL.md).
 */
import { SFACE_INPUT_SIZE } from "./align"

/** Distance between the two eye landmarks, in the image's pixels. */
export function interOcularDistance(landmarks: number[]): number {
  return Math.hypot(landmarks[2] - landmarks[0], landmarks[3] - landmarks[1])
}

/**
 * The smallest geometry margin, in eye-distances, of five YuNet landmarks
 * (image-left eye, image-right eye, nose, image-left mouth corner,
 * image-right mouth corner). Measured along the eye axis and across it, so a
 * tilt is allowed but not past a quarter turn:
 *   - the eye axis points rightwards (cosine of the tilt);
 *   - the nose lies below the eyes;
 *   - both mouth corners lie below the nose;
 *   - the mouth corners keep the eyes' left-right order.
 * Positive only when all four hold; collinear landmarks give 0. NaN-safe:
 * anything malformed is -1.
 */
export function landmarkGeometryMargin(landmarks: number[]): number {
  if (landmarks.length !== 10 || !landmarks.every(Number.isFinite)) return -1
  const [rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy] = landmarks
  const iod = Math.hypot(lex - rex, ley - rey)
  if (!(iod > 0)) return -1
  const [ux, uy] = [(lex - rex) / iod, (ley - rey) / iod]
  // "Down" across the eye axis, in image coordinates (y grows downwards).
  const [dx, dy] = [-uy, ux]
  const [mx, my] = [(rex + lex) / 2, (rey + ley) / 2]
  const depth = (x: number, y: number) => ((x - mx) * dx + (y - my) * dy) / iod
  const nose = depth(nx, ny)
  const mouth = Math.min(depth(rmx, rmy), depth(lmx, lmy))
  const mouthOrder = ((lmx - rmx) * ux + (lmy - rmy) * uy) / iod
  return Math.min(ux, nose, mouth - nose, mouthOrder)
}

// The warp fills zeros outside the image; edges against them are not detail.
const BORDER = 8

/**
 * Variance of the 4-neighbour Laplacian of the aligned crop's luma
 * (BT.601 weights), inside an 8 px border. Flat or blurred crops score near 0.
 */
export function alignedCropSharpness(tensor: Float32Array): number {
  const size = SFACE_INPUT_SIZE
  const plane = size * size
  const luma = (x: number, y: number) => {
    const at = y * size + x
    return 0.299 * tensor[at] + 0.587 * tensor[plane + at] + 0.114 * tensor[2 * plane + at]
  }
  let sum = 0
  let sumSquares = 0
  let count = 0
  for (let y = BORDER; y < size - BORDER; y++) {
    for (let x = BORDER; x < size - BORDER; x++) {
      const laplacian = luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1) - 4 * luma(x, y)
      sum += laplacian
      sumSquares += laplacian * laplacian
      count++
    }
  }
  const mean = sum / count
  return Math.max(0, sumSquares / count - mean * mean)
}
