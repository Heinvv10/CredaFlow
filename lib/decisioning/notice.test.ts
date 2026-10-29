import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ run: null as unknown, config: null as unknown }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    autoDecisionRun: { findFirst: vi.fn(async () => db.run) },
    decisionEngineConfig: { findUnique: vi.fn(async () => db.config) },
  },
}))

import { automatedDeclineNoticeFor, DRAFT_AUTOMATED_DECLINE_NOTICE } from "./notice"

const signedOff = { s71SignedOffAt: new Date("2026-10-01"), automatedDeclineNotice: "This decision was made by an automated process; you may ask for a person to review it." }

beforeEach(() => { db.run = { id: "r1" }; db.config = signedOff })

describe("automatedDeclineNoticeFor", () => {
  it("returns the lender's approved wording for an application the engine declined", async () => {
    expect(await automatedDeclineNoticeFor("t", "a")).toBe(signedOff.automatedDeclineNotice)
  })
  it("returns nothing for an application a person declined", async () => {
    db.run = null
    expect(await automatedDeclineNoticeFor("t", "a")).toBeNull()
  })
  it("returns nothing until the lender has signed off", async () => {
    db.config = { ...signedOff, s71SignedOffAt: null }
    expect(await automatedDeclineNoticeFor("t", "a")).toBeNull()
  })
  it("returns nothing when the lender has no wording", async () => {
    db.config = { ...signedOff, automatedDeclineNotice: null }
    expect(await automatedDeclineNoticeFor("t", "a")).toBeNull()
  })
})

describe("the draft suggestion", () => {
  it("is plainly marked as a draft and carries a TODO for the lender's legal team, so it can never be approved as it stands", async () => {
    const { parseEngineConfigPayload } = await import("./change-payloads")
    expect(DRAFT_AUTOMATED_DECLINE_NOTICE).toMatch(/draft/i)
    expect(DRAFT_AUTOMATED_DECLINE_NOTICE).toMatch(/TODO/)
    expect(() => parseEngineConfigPayload({ mode: "OFF", channels: [], productIds: [], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0, s71SignOff: true, automatedDeclineNotice: DRAFT_AUTOMATED_DECLINE_NOTICE })).toThrow()
  })
})
