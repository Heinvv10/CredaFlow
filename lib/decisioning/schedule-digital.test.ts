import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ order: [] as string[], mark: vi.fn(), run: vi.fn(), review: vi.fn(), logError: vi.fn() }))
vi.mock("@/lib/observability/logger", () => ({ logger: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("./digital-due", () => ({ markDigitalDecisionDue: h.mark, runDigitalDue: h.run }))
vi.mock("./digital-submission", () => ({ reviewDigitalSubmission: h.review }))
vi.mock("@/lib/http/after-response", () => ({ deferAfterResponse: vi.fn() }))

import { scheduleDigitalDecision } from "./schedule-digital"

const input = { tenantId: "t", applicationId: "a", clientId: "c", ip: "1.2.3.4" }
beforeEach(() => {
  h.order = []
  h.mark.mockReset().mockImplementation(async () => { h.order.push("mark"); return true })
  h.run.mockReset().mockImplementation(async () => { h.order.push("run") })
  h.review.mockReset().mockResolvedValue({ status: "REVIEWED" })
  h.logError.mockReset()
})

describe("scheduleDigitalDecision", () => {
  it("records the review as due BEFORE scheduling the after-response task, and does not run it inline", async () => {
    const scheduled: Array<() => Promise<void>> = []
    await scheduleDigitalDecision(input, (task) => { h.order.push("schedule"); scheduled.push(task) })
    expect(h.order).toEqual(["mark", "schedule"])
    expect(h.run).not.toHaveBeenCalled()
  })

  it("runs the due review for the application when the task runs", async () => {
    const scheduled: Array<() => Promise<void>> = []
    await scheduleDigitalDecision(input, (task) => { scheduled.push(task) })
    await scheduled[0]()
    expect(h.run).toHaveBeenCalledWith({ tenantId: "t", applicationId: "a" })
  })

  it("schedules nothing where the lender's engine does not cover the portal (no row was written)", async () => {
    h.mark.mockResolvedValueOnce(false)
    const scheduled: Array<() => Promise<void>> = []
    await scheduleDigitalDecision(input, (task) => { scheduled.push(task) })
    expect(scheduled).toHaveLength(0)
  })

  it("a failure to record the row is logged and NOTHING is scheduled or reviewed: the application stays with staff, and the submission never fails", async () => {
    h.mark.mockRejectedValueOnce(new Error("db down"))
    const scheduled: Array<() => Promise<void>> = []
    await expect(scheduleDigitalDecision(input, (task) => { scheduled.push(task) })).resolves.toBeUndefined()
    expect(scheduled).toHaveLength(0)
    // A review without its row would run without the daily limits on paid pulls (breaker 3): none is attempted.
    expect(h.review).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.logError).toHaveBeenCalledWith(expect.stringContaining("stays with staff"), expect.objectContaining({ applicationId: "a" }))
  })

  it("a failing task is logged, never thrown", async () => {
    h.run.mockRejectedValueOnce(new Error("db down"))
    const scheduled: Array<() => Promise<void>> = []
    await scheduleDigitalDecision(input, (task) => { scheduled.push(task) })
    await expect(scheduled[0]()).resolves.toBeUndefined()
    expect(h.logError).toHaveBeenCalled()
  })
})
