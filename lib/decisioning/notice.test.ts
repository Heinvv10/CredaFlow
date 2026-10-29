import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ run: null as unknown, app: null as unknown }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    autoDecisionRun: { findFirst: vi.fn(async () => db.run) },
    loanApplication: { findFirst: vi.fn(async () => db.app) },
  },
}))

import { automatedDeclineNoticeFor, DRAFT_AUTOMATED_DECLINE_NOTICE } from "./notice"

const NOTICE = "This decision was made by automated means; you may ask for a person to review it."
const systemDeclined = { status: "DECLINED", approvedBy: { isSystem: true } }

beforeEach(() => { db.app = systemDeclined; db.run = { id: "r1", noticeText: NOTICE } })

describe("automatedDeclineNoticeFor", () => {
  it("returns the wording that was in force when the engine declined this application", async () => {
    expect(await automatedDeclineNoticeFor("t", "a")).toBe(NOTICE)
  })
  it("returns nothing for an application a person declined (even if the engine declined it earlier)", async () => {
    db.app = { status: "DECLINED", approvedBy: { isSystem: false } }
    expect(await automatedDeclineNoticeFor("t", "a")).toBeNull()
  })
  it("returns nothing for one that is not declined, or has no decliner", async () => {
    db.app = { status: "UNDER_REVIEW", approvedBy: null }
    expect(await automatedDeclineNoticeFor("t", "a")).toBeNull()
    db.app = null
    expect(await automatedDeclineNoticeFor("t", "a")).toBeNull()
  })
  it("returns nothing when no wording was approved at the time (the run stored none)", async () => {
    db.run = { id: "r1", noticeText: null }
    expect(await automatedDeclineNoticeFor("t", "a")).toBeNull()
    db.run = null
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
