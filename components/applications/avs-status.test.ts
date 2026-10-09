import { describe, it, expect } from "vitest"
import { deriveAvsState, type AvsLatest } from "./avs-status"
// Server module import in a TEST file is fine (node environment) — the ban is
// only on the client component bundle pulling in prisma/node:async_hooks.
import { evaluateAvsGate } from "@/lib/avs"
import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"

describe("deriveAvsState (pure)", () => {
  it("is not_verified when no check exists", () => {
    expect(deriveAvsState(null, "123")).toBe("not_verified")
  })
  it("is not_verified when the client has no bank account captured", () => {
    expect(deriveAvsState({ passed: true, accountNumber: "123", createdAt: "2026-01-01", subjectMatches: true }, null)).toBe("not_verified")
  })
  it("is account_changed when the latest check is for a different account number", () => {
    expect(deriveAvsState({ passed: true, accountNumber: "999", createdAt: "2026-01-01", subjectMatches: false }, "123")).toBe("account_changed")
  })
  it("is account_changed when the AVS subject fingerprint no longer matches", () => {
    expect(deriveAvsState({
      passed: true,
      accountNumber: "123",
      createdAt: "2026-01-01",
      subjectMatches: false,
    }, "123")).toBe("account_changed")
  })
  it("is failed when the latest check failed for the current account", () => {
    expect(deriveAvsState({ passed: false, accountNumber: "123", createdAt: "2026-01-01", subjectMatches: true }, "123")).toBe("failed")
  })
  it("is verified on a passing check for the current account", () => {
    expect(deriveAvsState({ passed: true, accountNumber: "123", createdAt: "2026-01-01", subjectMatches: true }, "123")).toBe("verified")
  })
})

// lib/avs.ts's evaluateAvsGate and this file's deriveAvsState intentionally
// duplicate the same branch logic (deriveAvsState can't import evaluateAvsGate
// because that pulls prisma into the client bundle — see the file-header
// comment above). This test runs BOTH functions across the five canonical
// inputs and locks their outcomes together: if either implementation drifts,
// this test fails even though each one's own unit tests above stay green.
describe("cross-validation lock: evaluateAvsGate vs deriveAvsState stay in sync", () => {
  const cases: {
    label: string
    latest: AvsLatest
    currentAccountNumber: string | null
    expectGateOk: boolean
    expectState: ReturnType<typeof deriveAvsState>
  }[] = [
    {
      label: "null latest — no AVS check on record",
      latest: null,
      currentAccountNumber: "123",
      expectGateOk: false,
      expectState: "not_verified",
    },
    {
      label: "mismatched account — bank account changed since last check",
      latest: { passed: true, accountNumber: "999", createdAt: "2026-01-01", subjectMatches: false },
      currentAccountNumber: "123",
      expectGateOk: false,
      expectState: "account_changed",
    },
    {
      label: "failed check for the current account",
      latest: { passed: false, accountNumber: "123", createdAt: "2026-01-01", subjectMatches: true },
      currentAccountNumber: "123",
      expectGateOk: false,
      expectState: "failed",
    },
    {
      label: "passing check for the current account",
      latest: { passed: true, accountNumber: "123", createdAt: "2026-01-01", subjectMatches: true },
      currentAccountNumber: "123",
      expectGateOk: true,
      expectState: "verified",
    },
    {
      label: "null current account — client has no bank account captured",
      latest: { passed: true, accountNumber: "123", createdAt: "2026-01-01", subjectMatches: true },
      currentAccountNumber: null,
      expectGateOk: false,
      expectState: "not_verified",
    },
  ]

  it.each(cases)("$label", ({ latest, currentAccountNumber, expectGateOk, expectState }) => {
    const client = {
      id: "client-1",
      idNumber: "9001016000082",
      firstName: "Test",
      lastName: "Client",
      bankName: currentAccountNumber ? "FNB" : null,
      bankAccountNumber: currentAccountNumber,
      bankBranchCode: currentAccountNumber ? "250655" : null,
      accountType: currentAccountNumber ? "CHEQUE" : null,
    }
    const gate = evaluateAvsGate(latest ? {
      clientId: client.id,
      applicationId: "app-1",
      subjectFingerprint: latest.subjectMatches
        ? avsSubjectFingerprint(client)
        : "0".repeat(64),
      passed: latest.passed,
    } : null, client, "app-1")
    const state = deriveAvsState(latest, currentAccountNumber)

    expect(gate.ok).toBe(expectGateOk)
    expect(state).toBe(expectState)
    // The mapping the two implementations must never disagree on: the gate
    // permits disbursement iff the badge reads "verified".
    expect(gate.ok).toBe(state === "verified")
  })
})
