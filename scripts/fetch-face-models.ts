#!/usr/bin/env tsx
/**
 * Download the face-comparison models (YuNet + SFace) into FACE_MODEL_DIR
 * (default ./face-models), from opencv_zoo at the pinned commit, and refuse
 * any file whose SHA-256 is not the pinned one. The app re-checks the same
 * checksums when it loads them (lib/kyc/face-model/runtime.server.ts).
 *
 * Usage:  npm run face-models:fetch
 * A file already present with the right checksum is not downloaded again.
 * Exits 1 on any download or checksum failure, leaving no partial file.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { FACE_MODELS, faceModelUrl, type FaceModelFile } from "../lib/kyc/face-model/models"
import { faceModelDir } from "../lib/kyc/face-model/runtime.server"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function fetchModel(dir: string, model: FaceModelFile): Promise<void> {
  const target = path.join(dir, model.file)
  if (existsSync(target) && sha256(readFileSync(target)) === model.sha256) {
    console.log(`[face-models] ${model.file} present, checksum OK`)
    return
  }
  const response = await fetch(faceModelUrl(model))
  if (!response.ok) throw new Error(`${model.file}: HTTP ${response.status} from ${faceModelUrl(model)}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = sha256(bytes)
  if (digest !== model.sha256) {
    throw new Error(`${model.file}: sha256 ${digest}, expected ${model.sha256} (an LFS pointer is ~130 bytes; got ${bytes.length})`)
  }
  const partial = `${target}.partial`
  writeFileSync(partial, bytes)
  renameSync(partial, target)
  console.log(`[face-models] ${model.file} downloaded, ${bytes.length} bytes, checksum OK`)
}

async function main(): Promise<void> {
  const dir = faceModelDir()
  mkdirSync(dir, { recursive: true })
  for (const model of Object.values(FACE_MODELS)) {
    try {
      await fetchModel(dir, model)
    } catch (error) {
      rmSync(path.join(dir, `${model.file}.partial`), { force: true })
      throw error
    }
  }
}

main().catch((error: unknown) => {
  console.error(`[face-models] FAIL — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
