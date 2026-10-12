import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { FACE_MODELS, FACE_MODEL_LICENSES, OPENCV_ZOO_COMMIT } from "./models"

// The NOTICE the fetch script ships beside the models must account for every
// file it ships there: each model, and each licence text.
describe("face-model NOTICE", () => {
  const notice = readFileSync(path.join(__dirname, "NOTICE"), "utf8")

  it("names every shipped model and licence file, and the pinned commit", () => {
    for (const { file } of [...Object.values(FACE_MODELS), ...FACE_MODEL_LICENSES]) {
      expect(notice).toContain(file)
    }
    expect(notice).toContain(OPENCV_ZOO_COMMIT)
  })

  it("pins every licence text by SHA-256 at a commit, never a moving ref", () => {
    for (const licence of FACE_MODEL_LICENSES) {
      expect(licence.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(licence.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//)
    }
  })
})
