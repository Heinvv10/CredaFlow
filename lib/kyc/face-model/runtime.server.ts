/**
 * Loads the two ONNX models into onnxruntime-node (CPU only) once per
 * process. Each file's SHA-256 is checked against the pinned value on the
 * exact bytes handed to the runtime, so a swapped file never loads. A load
 * that fails or overruns FACE_MODEL_LOAD_TIMEOUT_MS is not cached: the next
 * comparison tries again, and until one succeeds every comparison fails
 * closed.
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { FACE_MODELS, type FaceModelFile } from "./models"
import { SFACE_INPUT_SIZE } from "./align"
import { YUNET_INPUT_SIZE, type YunetOutputs } from "./yunet"

export interface FaceModelRuntime {
  /** YuNet on a 1x3x640x640 BGR tensor: its twelve outputs by name. */
  detect(input: Float32Array): Promise<YunetOutputs>
  /** SFace on a 1x3x112x112 RGB tensor: the 128-value embedding. */
  embed(input: Float32Array): Promise<Float32Array>
}

const SFACE_EMBEDDING_LENGTH = 128

/** FACE_MODEL_DIR, or face-models/ under the working directory (/app in the image). */
export function faceModelDir(env: Record<string, string | undefined> = process.env): string {
  return env.FACE_MODEL_DIR?.trim() || path.join(process.cwd(), "face-models")
}

export async function readVerifiedModel(dir: string, model: FaceModelFile): Promise<Buffer> {
  const file = path.join(dir, model.file)
  const bytes = await readFile(file).catch(() => {
    throw new Error(`Face model ${file} is missing; run npm run face-models:fetch`)
  })
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== model.sha256) {
    throw new Error(`Face model ${file} failed its checksum (sha256 ${digest}, expected ${model.sha256})`)
  }
  return bytes
}

async function createRuntime(dir: string): Promise<FaceModelRuntime> {
  const [detectorBytes, recognizerBytes] = await Promise.all([
    readVerifiedModel(dir, FACE_MODELS.detector),
    readVerifiedModel(dir, FACE_MODELS.recognizer),
  ])
  // Imported here so a process that never compares a face never loads the
  // native binding, and a binding that fails to load fails this call only.
  const ort = await import("onnxruntime-node")
  // logSeverityLevel 3: the opset-11 SFace graph warns about every initializer.
  const options = { executionProviders: ["cpu"], logSeverityLevel: 3 as const }
  const detector = await ort.InferenceSession.create(detectorBytes, options)
  const recognizer = await ort.InferenceSession.create(recognizerBytes, options)
  return {
    async detect(input) {
      const size = YUNET_INPUT_SIZE
      const result = await detector.run({ input: new ort.Tensor("float32", input, [1, 3, size, size]) })
      const outputs: YunetOutputs = {}
      for (const [name, tensor] of Object.entries(result)) {
        if (tensor.data instanceof Float32Array) outputs[name] = tensor.data
      }
      return outputs
    },
    async embed(input) {
      const size = SFACE_INPUT_SIZE
      const result = await recognizer.run({ data: new ort.Tensor("float32", input, [1, 3, size, size]) })
      const embedding = result.fc1?.data
      if (!(embedding instanceof Float32Array) || embedding.length !== SFACE_EMBEDDING_LENGTH) {
        throw new Error("SFace returned no 128-value embedding")
      }
      return embedding
    },
  }
}

/** A cold load measured under a second; well inside FACE_COMPARISON_TIMEOUT_MS. */
export const FACE_MODEL_LOAD_TIMEOUT_MS = 20_000

let runtime: Promise<FaceModelRuntime> | null = null

/**
 * The process's runtime. A hung load would otherwise stay cached as a
 * promise that never settles, and every later comparison would time out.
 */
export function loadFaceModelRuntime(
  create: () => Promise<FaceModelRuntime> = () => createRuntime(faceModelDir()),
  timeoutMs = FACE_MODEL_LOAD_TIMEOUT_MS,
): Promise<FaceModelRuntime> {
  if (!runtime) {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Face model load timed out after ${timeoutMs} ms`)), timeoutMs)
    })
    runtime = Promise.race([create(), timeout])
      .finally(() => clearTimeout(timer))
      .catch((error: unknown) => {
        runtime = null
        throw error
      })
  }
  return runtime
}
