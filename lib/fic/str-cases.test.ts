import { describe, expect, it } from "vitest"
import { ROLE_HIERARCHY } from "@/lib/permissions"
import { canAccessStrRegister, canRaiseStr, canTransitionStr, generateStrReference, parseStrUpdate } from "./str-cases"

describe("STR access", () => {
  it("restricts the register to ADMIN and SUPER_ADMIN", () => {
    const allowed = ROLE_HIERARCHY.filter((r) => canAccessStrRegister(r))
    expect(allowed).toEqual(["ADMIN", "SUPER_ADMIN"])
  })

  it("refuses every role below ADMIN, the client and an unknown role", () => {
    for (const role of ["READONLY", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "INSURANCE_OFFICER", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "CLIENT", "COMPLIANCE"]) {
      expect(canAccessStrRegister(role), role).toBe(false)
    }
  })

  it("lets every operational role raise a case, but not READONLY or a client", () => {
    expect(canRaiseStr("COLLECTIONS_OFFICER")).toBe(true)
    expect(canRaiseStr("CREDIT_OFFICER")).toBe(true)
    expect(canRaiseStr("READONLY")).toBe(false)
    expect(canRaiseStr("CLIENT")).toBe(false)
  })
})

describe("STR lifecycle", () => {
  it("moves forward only, and a decided case never moves", () => {
    expect(canTransitionStr("OPEN", "UNDER_REVIEW")).toBe(true)
    expect(canTransitionStr("OPEN", "REPORTED")).toBe(true)
    expect(canTransitionStr("UNDER_REVIEW", "CLOSED_NO_REPORT")).toBe(true)
    expect(canTransitionStr("UNDER_REVIEW", "OPEN")).toBe(false)
    for (const to of ["OPEN", "UNDER_REVIEW", "REPORTED", "CLOSED_NO_REPORT"] as const) {
      expect(canTransitionStr("REPORTED", to)).toBe(false)
      expect(canTransitionStr("CLOSED_NO_REPORT", to)).toBe(false)
    }
  })

  it("requires the FIC reference and a past filing date to mark a case REPORTED", () => {
    expect(parseStrUpdate({ status: "REPORTED", reportedAt: "2026-10-01" }).ok).toBe(false)
    expect(parseStrUpdate({ status: "REPORTED", fiuReference: "GOAML-0001", reportedAt: "2999-01-01" }).ok).toBe(false)
    expect(parseStrUpdate({ status: "REPORTED", fiuReference: "GOAML-0001", reportedAt: "2026-10-01" }))
      .toMatchObject({ ok: true, value: { status: "REPORTED", fiuReference: "GOAML-0001" } })
  })

  it("requires a reason to close without reporting", () => {
    expect(parseStrUpdate({ status: "CLOSED_NO_REPORT", assessmentNote: "too short" }).ok).toBe(false)
    expect(parseStrUpdate({ status: "CLOSED_NO_REPORT", assessmentNote: "Explained: salary advance from employer." }).ok).toBe(true)
    expect(parseStrUpdate({ status: "OPEN" }).ok).toBe(false)
  })

  it("issues references of a fixed, non-identifying shape", () => {
    expect(generateStrReference(new Date("2026-10-14T10:00:00Z"))).toMatch(/^STR-20261014-[0-9A-F]{6}$/)
  })
})
