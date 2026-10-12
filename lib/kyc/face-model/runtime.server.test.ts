import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FACE_MODELS } from "./models"
import { faceModelDir, loadFaceModelRuntime, readVerifiedModel, verifiedRuntimeDetector } from "./runtime.server"

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "face-model-test-"))
  dirs.push(dir)
  return dir
}
const savedDir = process.env.FACE_MODEL_DIR

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedDir === undefined) delete process.env.FACE_MODEL_DIR
  else process.env.FACE_MODEL_DIR = savedDir
})

describe("faceModelDir", () => {
  it("defaults to face-models under the working directory and honours FACE_MODEL_DIR", () => {
    expect(faceModelDir({})).toBe(path.join(process.cwd(), "face-models"))
    expect(faceModelDir({ FACE_MODEL_DIR: "  " })).toBe(path.join(process.cwd(), "face-models"))
    expect(faceModelDir({ FACE_MODEL_DIR: "/opt/models" })).toBe("/opt/models")
  })
})

describe("readVerifiedModel", () => {
  it("refuses a missing file", async () => {
    await expect(readVerifiedModel(scratch(), FACE_MODELS.detector)).rejects.toThrow(/face_detection_yunet_2023mar.onnx/)
  })

  it("refuses a file whose SHA-256 is not the pinned one", async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, FACE_MODELS.recognizer.file), "not the model")
    await expect(readVerifiedModel(dir, FACE_MODELS.recognizer)).rejects.toThrow(/checksum/)
  })

  it("returns the bytes it hashed when the checksum matches", async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, "probe.onnx"), "probe")
    const probe = {
      name: "probe",
      file: "probe.onnx",
      repoPath: "probe.onnx",
      // sha256("probe")
      sha256: "6f4de8a5e9ed3d1b3c1b8f2e4bf9e08b0a2a1ed2b1e8d3ea0f1b9e7aa2e3b2b0",
    }
    await expect(readVerifiedModel(dir, probe)).rejects.toThrow(/checksum/)
    const { createHash } = await import("node:crypto")
    probe.sha256 = createHash("sha256").update("probe").digest("hex")
    await expect(readVerifiedModel(dir, probe)).resolves.toEqual(Buffer.from("probe"))
  })
})

describe("verifiedRuntimeDetector", () => {
  it("refuses patched detector bytes whose SHA-256 is not the pinned one", () => {
    expect(() => verifiedRuntimeDetector(Buffer.from("not the patched detector"))).toThrow(/checksum/)
  })
})

describe("loadFaceModelRuntime", () => {
  it("rejects when the model files are absent, and tries again on the next call", async () => {
    process.env.FACE_MODEL_DIR = scratch()
    await expect(loadFaceModelRuntime()).rejects.toThrow(/is missing/)
    process.env.FACE_MODEL_DIR = scratch()
    writeFileSync(path.join(process.env.FACE_MODEL_DIR, FACE_MODELS.detector.file), "tampered")
    writeFileSync(path.join(process.env.FACE_MODEL_DIR, FACE_MODELS.recognizer.file), "tampered")
    await expect(loadFaceModelRuntime()).rejects.toThrow(/checksum/)
  })
})

describe("loadFaceModelRuntime's cache", () => {
  // A fresh module per test: the cache is module state.
  const freshModule = async () => {
    vi.resetModules()
    return import("./runtime.server")
  }
  const fake = () => ({ detect: vi.fn(), embed: vi.fn() })

  it("does not cache a load that hangs: it times out and the next call loads again", async () => {
    const { loadFaceModelRuntime: load } = await freshModule()
    await expect(load(() => new Promise(() => {}), 20)).rejects.toThrow(/timed out/)
    const runtime = fake()
    await expect(load(async () => runtime, 20)).resolves.toBe(runtime)
  })

  it("does not cache a load that fails", async () => {
    const { loadFaceModelRuntime: load } = await freshModule()
    await expect(load(async () => { throw new Error("binding failed") }, 1000)).rejects.toThrow("binding failed")
    const runtime = fake()
    await expect(load(async () => runtime, 1000)).resolves.toBe(runtime)
  })

  it("caches a load that succeeds", async () => {
    const { loadFaceModelRuntime: load } = await freshModule()
    const first = fake()
    await expect(load(async () => first, 1000)).resolves.toBe(first)
    await expect(load(async () => fake(), 1000)).resolves.toBe(first)
  })
})
