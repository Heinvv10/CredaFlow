import { describe, expect, it } from "vitest"
import { approvePermissionFor } from "@/lib/maker-checker/types"
import { canDo } from "@/lib/permissions"
import { approvalMatrixHandler } from "./change-handler"
import type { MatrixPayload } from "./types"

const matrix = (over: Partial<MatrixPayload> = {}): MatrixPayload => ({
  name: "m", enabled: true, effectiveFrom: "2026-11-01", defaultRequiredLevels: 1,
  levels: [{ level: 1, name: "L1", role: "LOAN_ADMIN", slaHours: 24, committee: false }, { level: 2, name: "L2", role: "ADMIN", slaHours: 24, committee: false }],
  rules: [{ id: "r", name: "r", when: { amountMinCents: 1 }, requiredLevels: 2 }], ...over,
})

describe("who may approve a matrix change", () => {
  it.each([
    ["a change that keeps every application under staff approval", {}],
    ["the matrix switched off", { enabled: false }],
    ["no staff approval where no rule matches", { defaultRequiredLevels: 0 }],
    ["a rule needing no staff approval", { rules: [{ id: "auto", name: "auto", when: { amountMaxCents: 100 }, requiredLevels: 0 }] }],
    ["rules dropped", { rules: [] }],
  ])("%s: only a SUPER_ADMIN approves (two administrators could otherwise cut every approval)", (_name, over) => {
    const permission = approvePermissionFor(approvalMatrixHandler, matrix(over))
    expect(permission).toBe("approve_approval_matrix")
    expect(canDo("ADMIN", permission)).toBe(false)
    expect(canDo("SUPER_ADMIN", permission)).toBe(true)
  })

  it("drafting needs an ADMIN, and a LOAN_ADMIN cannot", () => {
    expect(canDo("ADMIN", approvalMatrixHandler.makePermission)).toBe(true)
    expect(canDo("LOAN_ADMIN", approvalMatrixHandler.makePermission)).toBe(false)
  })
})
