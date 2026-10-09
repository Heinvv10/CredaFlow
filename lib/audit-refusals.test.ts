import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  AuditAction: { LOAN_DISBURSEMENT_REFUSED: "LOAN_DISBURSEMENT_REFUSED" },
}))

import { logAudit } from "@/lib/audit"
import { auditRefusal, refusalReasonFrom } from "./audit-refusals"

describe("refusalReasonFrom", () => {
  it("extracts the cause from a refusal response", async () => {
    const res = new Response(JSON.stringify({ error: "no", disbursementPrecondition: "signed_agreement" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })
    expect(await refusalReasonFrom(res, "disbursementPrecondition")).toEqual({
      reason: "signed_agreement",
      status: 422,
    })
  })

  it("does not consume the body — the caller still returns this response", async () => {
    // The seam runs on a response the route is ABOUT to return. Reading the
    // body instead of a clone would empty it and the caller would ship a
    // truncated payload to the operator.
    const res = new Response(JSON.stringify({ disbursementPrecondition: "composite_kyc" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    })
    await refusalReasonFrom(res, "disbursementPrecondition")
    expect(await res.json()).toEqual({ disbursementPrecondition: "composite_kyc" })
  })

  it("is a no-op on success, so the happy path writes nothing", async () => {
    const res = new Response(JSON.stringify({ success: true }), { status: 200 })
    expect(await refusalReasonFrom(res, "disbursementPrecondition")).toBeNull()
  })

  it("returns null for an error carrying no structured cause", async () => {
    // A 500 is a failure, not a refusal. Logging it as one would file crashes
    // as compliance decisions.
    const res = new Response(JSON.stringify({ error: "Failed to disburse loan" }), { status: 500 })
    expect(await refusalReasonFrom(res, "disbursementPrecondition")).toBeNull()
  })

  it("returns null for a non-JSON body rather than throwing", async () => {
    const res = new Response("<html>gateway timeout</html>", { status: 504 })
    expect(await refusalReasonFrom(res, "disbursementPrecondition")).toBeNull()
  })
})

describe("auditRefusal", () => {
  it("marks the row as a refusal and carries the cause", async () => {
    vi.mocked(logAudit).mockClear()
    await auditRefusal({
      action: "LOAN_DISBURSEMENT_REFUSED" as never,
      entity: "LoanApplication",
      entityId: "app-1",
      userEmail: "officer@acme-lending.example",
      reason: "composite_kyc",
      status: 422,
    })
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "LoanApplication",
        entityId: "app-1",
        userEmail: "officer@acme-lending.example",
        newValue: expect.objectContaining({
          refused: true,
          reason: "composite_kyc",
          httpStatus: 422,
        }),
      }),
    )
  })
})

describe("refusalReasonFrom without the marker", () => {
  it("still records a 4xx refusal that carries no precondition field", async () => {
    // The preflight AVS 409 and the accepted-PASQ fingerprint 422 do not set
    // the marker. Keying only on it meant those refusals wrote no row at all.
    const res = new Response(JSON.stringify({ error: "AVS mismatch" }), { status: 409 })
    expect(await refusalReasonFrom(res, "disbursementPrecondition")).toEqual({
      reason: "unlabelled_409",
      status: 409,
    })
  })

  it("prefers the marker when present, so the cause is not lost", async () => {
    const res = new Response(JSON.stringify({ disbursementPrecondition: "composite_kyc" }), { status: 422 })
    expect(await refusalReasonFrom(res, "disbursementPrecondition")).toEqual({
      reason: "composite_kyc",
      status: 422,
    })
  })
})
