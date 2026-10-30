import { afterEach, describe, expect, it, vi } from "vitest"

const run = vi.hoisted(() => vi.fn())
const logError = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability/logger", () => ({ logger: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("./auto-decision", () => ({ runAutoDecision: run }))

import { runAutoDecisionSafely, statusAfterAutoDecision } from "./run-safely"
import type { AutoDecisionOutcome } from "./auto-decision"

const ran = (execution: "APPROVED" | "DECLINED" | "REFERRED" | "NOT_ACTED"): AutoDecisionOutcome => ({
  status: "RAN", runId: "r", execution, verdict: { decision: "APPROVE", reasonCodes: ["X"], declineCategory: null, riskGrade: null, gradeRank: null, score: null, pricingTier: null, limitCapCents: null, hits: [] },
  role: "CHAMPION", ruleSet: "ALL:v1", latencyMs: 1, note: null,
})

afterEach(() => vi.restoreAllMocks())

describe("runAutoDecisionSafely", () => {
  const input = { tenantId: "t", applicationId: "a", trigger: "REVIEW_STARTED" } as const
  it("passes the outcome through", async () => {
    run.mockResolvedValueOnce({ status: "SKIPPED", reason: "engine_off" })
    expect(await runAutoDecisionSafely(input)).toEqual({ status: "SKIPPED", reason: "engine_off" })
  })
  it("logs a failure and answers null, so the review it ran inside never fails", async () => {
    run.mockRejectedValueOnce(new Error("db down"))
    expect(await runAutoDecisionSafely(input)).toBeNull()
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("stays with staff"), expect.objectContaining({ applicationId: "a" }))
  })
})

describe("statusAfterAutoDecision", () => {
  it("only an executed approval or decline moves the application", () => {
    expect(statusAfterAutoDecision(ran("APPROVED"))).toBe("APPROVED")
    expect(statusAfterAutoDecision(ran("DECLINED"))).toBe("DECLINED")
    expect(statusAfterAutoDecision(ran("REFERRED"))).toBe("UNDER_REVIEW")
    expect(statusAfterAutoDecision(ran("NOT_ACTED"))).toBe("UNDER_REVIEW")
    expect(statusAfterAutoDecision({ status: "SKIPPED", reason: "engine_off" })).toBe("UNDER_REVIEW")
  })
})
