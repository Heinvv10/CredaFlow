import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ config: null as unknown, app: null as unknown, system: null as unknown, startReview: vi.fn(), runEngine: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    decisionEngineConfig: { findUnique: vi.fn(async () => h.config) },
    loanApplication: { findFirst: vi.fn(async () => h.app) },
  },
}))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (_t: string, fn: () => unknown) => fn() }))
vi.mock("@/app/api/applications/[id]/review/review-application", () => ({ startApplicationReview: h.startReview }))
vi.mock("./auto-decision", () => ({ runAutoDecision: h.runEngine }))
vi.mock("./system-user", () => ({ findSystemUser: vi.fn(async () => h.system) }))

import { reviewDigitalSubmission } from "./digital-submission"

const input = { tenantId: "t", applicationId: "a" }
const live = { mode: "LIVE", channels: ["PORTAL"], productIds: ["p1"] }
beforeEach(() => {
  h.config = live
  h.app = { status: "SUBMITTED", productId: "p1" }
  h.system = { id: "sys", email: "s@system.invalid", role: "LOAN_ADMIN" }
  h.startReview.mockReset().mockResolvedValue({ ok: true })
  h.runEngine.mockReset().mockResolvedValue({ status: "RAN" })
})

describe("reviewDigitalSubmission", () => {
  it("LIVE: starts the review as the system user, unassigned, and lets the engine decide inside it", async () => {
    expect(await reviewDigitalSubmission(input)).toEqual({ status: "REVIEWED" })
    expect(h.startReview).toHaveBeenCalledWith(expect.objectContaining({ user: h.system, autoDecisionTrigger: "DIGITAL_SUBMISSION", assignToUser: false }))
  })

  it("SHADOW: records a rehearsal only. No review (so no status change, no assignment, no paid bureau pull)", async () => {
    h.config = { ...live, mode: "SHADOW" }
    expect(await reviewDigitalSubmission(input)).toEqual({ status: "REHEARSED" })
    expect(h.startReview).not.toHaveBeenCalled()
    expect(h.runEngine).toHaveBeenCalledWith({ tenantId: "t", applicationId: "a", trigger: "DIGITAL_SUBMISSION" })
  })

  it.each([
    ["no settings", null, "engine_off"],
    ["engine off", { ...live, mode: "OFF" }, "mode_off"],
    ["portal not covered", { ...live, channels: ["STAFF"] }, "channel_not_enabled"],
    ["product not covered", { ...live, productIds: ["other"] }, "product_not_enabled"],
  ])("skips: %s", async (_name, config, reason) => {
    h.config = config
    expect(await reviewDigitalSubmission(input)).toEqual({ status: "SKIPPED", reason })
    expect(h.startReview).not.toHaveBeenCalled()
    expect(h.runEngine).not.toHaveBeenCalled()
  })

  it("skips an application that is no longer SUBMITTED, and a LIVE lender with no system user", async () => {
    h.app = { status: "UNDER_REVIEW", productId: "p1" }
    expect(await reviewDigitalSubmission(input)).toEqual({ status: "SKIPPED", reason: "application_not_submitted" })
    h.app = { status: "SUBMITTED", productId: "p1" }
    h.system = null
    expect(await reviewDigitalSubmission(input)).toEqual({ status: "SKIPPED", reason: "no_system_user" })
  })

  it("reports a review the staff steps refused (unverified KYC, say) and leaves the application with staff", async () => {
    h.startReview.mockResolvedValueOnce(new Response("{}", { status: 422 }))
    expect(await reviewDigitalSubmission(input)).toEqual({ status: "REVIEW_REFUSED", httpStatus: 422 })
  })
})
