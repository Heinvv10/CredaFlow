#!/usr/bin/env tsx
/**
 * Download the face-comparison models (YuNet + SFace) into FACE_MODEL_DIR
 * (default ./face-models), from opencv_zoo at the pinned commit, and refuse
 * any file whose SHA-256 is not the pinned one. The app re-checks the same
 * checksums when it loads them (lib/kyc/face-model/runtime.server.ts).
 * Their licence texts are fetched the same way, checksum-pinned, and the
 * NOTICE in lib/kyc/face-model/ is copied beside them, so the image ships all
 * three with the models.
 *
 * Usage:  npm run face-models:fetch
 * A file already present with the right checksum is not downloaded again.
 * Exits 1 on any download or checksum failure, leaving no partial file.
 */
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { FACE_MODELS, FACE_MODEL_LICENSES, faceModelUrl } from "../lib/kyc/face-model/models"
import { faceModelDir } from "../lib/kyc/face-model/runtime.server"
import { downloadPinnedFile } from "./fetch-face-models-download"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

type PinnedFile = { file: string; url: string; sha256: string }

async function fetchPinned(dir: string, model: PinnedFile): Promise<void> {
  const target = path.join(dir, model.file)
  if (existsSync(target) && sha256(readFileSync(target)) === model.sha256) {
    console.log(`[face-models] ${model.file} present, checksum OK`)
    return
  }
  const length = await downloadPinnedFile(target, model)
  console.log(`[face-models] ${model.file} downloaded, ${length} bytes, checksum OK`)
}

async function main(): Promise<void> {
  const dir = faceModelDir()
  mkdirSync(dir, { recursive: true })
  const pinned: PinnedFile[] = [
    ...Object.values(FACE_MODELS).map((model) => ({ ...model, url: faceModelUrl(model) })),
    ...FACE_MODEL_LICENSES,
  ]
  for (const file of pinned) {
    try {
      await fetchPinned(dir, file)
    } catch (error) {
      rmSync(path.join(dir, `${file.file}.partial`), { force: true })
      throw error
    }
  }
  copyFileSync(path.join(__dirname, "..", "lib", "kyc", "face-model", "NOTICE"), path.join(dir, "NOTICE"))
  console.log("[face-models] NOTICE copied")
}

main().catch((error: unknown) => {
  console.error(`[face-models] FAIL — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
