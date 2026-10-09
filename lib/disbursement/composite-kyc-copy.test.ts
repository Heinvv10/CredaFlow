import { readFileSync } from "fs"
import path from "path"
import { describe, expect, it } from "vitest"

/**
 * The composite KYC gate is satisfied by THREE independent substitutes —
 * a valid biometric, a senior exception over a failed selfie, or an in-person
 * verification where none could be captured (lib/kyc/document-state.ts:
 * substituteEvidence = manualException ?? inPersonVerification).
 *
 * That requirement is restated in prose in three separate places. They drifted:
 * one claimed biometrics were mandatory, two named only two of the three paths,
 * and staff reading them could conclude an in-person-verified client was
 * blocked when they were not. No test asserted any of the strings, so nothing
 * caught it — the reason this guard exists.
 */
const ROOT = path.resolve(__dirname, "..", "..")
const SURFACES = [
  "lib/disbursement/preconditions.ts",
  "app/api/applications/[id]/disburse/route.ts",
  "app/api/clients/[id]/route.ts",
]

describe("composite KYC copy names every substitute path", () => {
  it.each(SURFACES)("states all three wherever %s restates the gate", (rel) => {
    const source = readFileSync(path.join(ROOT, rel), "utf8")
    const claims = source
      .split("\n")
      .filter((line) => /senior exception/i.test(line) && !line.trim().startsWith("//"))
    expect(claims.length).toBeGreaterThan(0)
    for (const claim of claims) {
      expect(claim).toMatch(/in-person verification/i)
    }
  })

  it("has no surface left describing the gate as biometric-only", () => {
    for (const rel of SURFACES) {
      const source = readFileSync(path.join(ROOT, rel), "utf8")
      expect(source).not.toMatch(/either the current valid biometric attempt or an exact reasoned senior exception/i)
      expect(source).not.toMatch(/Failed biometrics require the separate/i)
    }
  })
})
