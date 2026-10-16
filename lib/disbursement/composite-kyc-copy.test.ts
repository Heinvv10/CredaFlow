import { readFileSync } from "fs"
import path from "path"
import { describe, expect, it } from "vitest"
import { kycApprovalBlockedMessage } from "@/lib/kyc/approval-blocked-message"

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

// The KYC-approval refusal (app/api/clients/[id]/route.ts) now speaks plain
// words (lib/kyc/approval-blocked-message.ts) and must still name all three.
describe("KYC approval refusal names every substitute path", () => {
  it("names a passing selfie, an in-person verification and a reasoned exception", () => {
    const message = kycApprovalBlockedMessage({ enabled: true, minRole: "ADMIN" })
    expect(message).toMatch(/selfie that passed/)
    expect(message).toMatch(/in person/)
    expect(message).toMatch(/reasoned exception/)
  })
})
