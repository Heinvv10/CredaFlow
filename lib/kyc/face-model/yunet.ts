/**
 * YuNet face detector (OpenCV Zoo face_detection_yunet_2023mar): the input
 * layout and the output decoding, as plain typed-array math.
 *
 * Follows cv::FaceDetectorYN (opencv/modules/objdetect/src/face_detect.cpp):
 * BGR planes of raw 0-255 values, zero padding on the bottom and right,
 * anchor-free decoding over strides 8/16/32, score = sqrt(cls * obj), then
 * NMS over integer boxes. The one difference: the caller normally shrinks the
 * image to fit 640x640 and passes the scale, where OpenCV reshapes the network
 * to the image. The ID side's full-resolution pass runs at the image's own
 * size, padded to a multiple of 32 (onnx-shape.ts makes that possible).
 */
export const YUNET_INPUT_SIZE = 640
const STRIDES = [8, 16, 32] as const
// cv::FaceDetectorYN::create defaults, also the opencv_zoo demo's.
export const YUNET_SCORE_THRESHOLD = 0.9
export const YUNET_NMS_THRESHOLD = 0.3
export const YUNET_TOP_K = 5000

/** Interleaved 8-bit RGB, row by row. */
export interface RgbImage {
  data: Uint8Array
  width: number
  height: number
}

export interface DetectedFace {
  x: number
  y: number
  width: number
  height: number
  /** x,y pairs: right eye, left eye, nose tip, right mouth corner, left mouth corner. */
  landmarks: number[]
  score: number
}

/** The model's twelve outputs by name: cls_8 .. kps_32, each flattened. */
export type YunetOutputs = Record<string, Float32Array>

const LARGEST_STRIDE = 32

/** Width and height must be multiples of the largest stride. */
function checkInputSize(inputWidth: number, inputHeight: number) {
  if (!(inputWidth > 0 && inputHeight > 0 && inputWidth % LARGEST_STRIDE === 0 && inputHeight % LARGEST_STRIDE === 0)) {
    throw new Error(`YuNet input size must be a positive multiple of ${LARGEST_STRIDE}`)
  }
}

/** The 1x3xHxW input (640x640 by default) for an image no larger than that. */
export function yunetInputTensor(
  image: RgbImage,
  inputWidth = YUNET_INPUT_SIZE,
  inputHeight = YUNET_INPUT_SIZE,
): Float32Array {
  checkInputSize(inputWidth, inputHeight)
  const { data, width, height } = image
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > inputWidth || height > inputHeight ||
    data.length !== width * height * 3
  ) {
    throw new Error(`YuNet input must be RGB of at most ${inputWidth}x${inputHeight}`)
  }
  const plane = inputWidth * inputHeight
  const tensor = new Float32Array(3 * plane)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 3
      const target = y * inputWidth + x
      tensor[target] = data[source + 2]
      tensor[plane + target] = data[source + 1]
      tensor[2 * plane + target] = data[source]
    }
  }
  return tensor
}

function output(outputs: YunetOutputs, name: string, length: number): Float32Array {
  const values = outputs[name]
  if (!(values instanceof Float32Array) || values.length !== length) {
    throw new Error(`YuNet output ${name} is missing or has the wrong size`)
  }
  return values
}

/**
 * Faces in ORIGINAL image coordinates, strongest first. `scale` is the factor
 * the image was shrunk by to fit the input (1 when it was not); the input
 * size is 640x640 unless given.
 */
export function decodeYunetOutputs(
  outputs: YunetOutputs,
  scale: number,
  inputWidth = YUNET_INPUT_SIZE,
  inputHeight = YUNET_INPUT_SIZE,
): DetectedFace[] {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("YuNet scale must be a positive number")
  checkInputSize(inputWidth, inputHeight)
  const faces: DetectedFace[] = []
  for (const stride of STRIDES) {
    const cols = inputWidth / stride
    const cells = cols * (inputHeight / stride)
    const cls = output(outputs, `cls_${stride}`, cells)
    const obj = output(outputs, `obj_${stride}`, cells)
    const bbox = output(outputs, `bbox_${stride}`, cells * 4)
    const kps = output(outputs, `kps_${stride}`, cells * 10)
    for (let index = 0; index < cells; index++) {
      if (!Number.isFinite(cls[index]) || !Number.isFinite(obj[index])) {
        throw new Error("YuNet produced a non-finite score")
      }
      const clamp = (value: number) => Math.max(0, Math.min(1, value))
      const score = Math.sqrt(clamp(cls[index]) * clamp(obj[index]))
      if (score < YUNET_SCORE_THRESHOLD) continue
      const row = Math.floor(index / cols)
      const col = index % cols
      const width = Math.exp(bbox[index * 4 + 2]) * stride
      const height = Math.exp(bbox[index * 4 + 3]) * stride
      const landmarks: number[] = []
      for (let n = 0; n < 5; n++) {
        landmarks.push((kps[index * 10 + 2 * n] + col) * stride, (kps[index * 10 + 2 * n + 1] + row) * stride)
      }
      const face = {
        x: (col + bbox[index * 4]) * stride - width / 2,
        y: (row + bbox[index * 4 + 1]) * stride - height / 2,
        width,
        height,
        landmarks,
        score,
      }
      if (![face.x, face.y, width, height, ...landmarks].every(Number.isFinite)) {
        throw new Error("YuNet produced a non-finite box")
      }
      faces.push(face)
    }
  }
  return nonMaxSuppression(faces).map((face) => ({
    x: face.x / scale,
    y: face.y / scale,
    width: face.width / scale,
    height: face.height / scale,
    landmarks: face.landmarks.map((value) => value / scale),
    score: face.score,
  }))
}

/** Intersection over union of two boxes truncated to whole pixels (cv::Rect2i). */
export function overlap(a: DetectedFace, b: DetectedFace): number {
  const [ax, ay, aw, ah] = [a.x, a.y, a.width, a.height].map(Math.trunc)
  const [bx, by, bw, bh] = [b.x, b.y, b.width, b.height].map(Math.trunc)
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx)
  const h = Math.min(ay + ah, by + bh) - Math.max(ay, by)
  if (w <= 0 || h <= 0) return 0
  const intersection = w * h
  return intersection / (aw * ah + bw * bh - intersection)
}

/**
 * cv::dnn::NMSBoxes: strongest first, a box is kept unless it overlaps an
 * already kept one by MORE than the threshold.
 */
export function nonMaxSuppression(
  faces: DetectedFace[],
  threshold = YUNET_NMS_THRESHOLD,
  topK = YUNET_TOP_K,
): DetectedFace[] {
  const kept: DetectedFace[] = []
  for (const face of [...faces].sort((a, b) => b.score - a.score).slice(0, topK)) {
    if (kept.every((other) => overlap(face, other) <= threshold)) kept.push(face)
  }
  return kept
}
