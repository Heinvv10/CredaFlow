import { describe, expect, it, vi } from "vitest"

const review = vi.hoisted(() => vi.fn())
vi.mock("./digital-submission", () => ({ reviewDigitalSubmission: review }))
vi.mock("@/lib/http/after-response", () => ({ deferAfterResponse: vi.fn() }))

import { scheduleDigitalDecision } from "./schedule-digital"

describe("scheduleDigitalDecision", () => {
  it("does not run the review inline: the caller's response is not held up", () => {
    review.mockReset()
    const scheduled: Array<() => Promise<void>> = []
    scheduleDigitalDecision({ tenantId: "t", applicationId: "a" }, (task) => { scheduled.push(task) })
    expect(review).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
  })

  it("runs the review for the application when the task runs", async () => {
    review.mockReset().mockResolvedValue({ status: "REVIEWED" })
    const scheduled: Array<() => Promise<void>> = []
    scheduleDigitalDecision({ tenantId: "t", applicationId: "a" }, (task) => { scheduled.push(task) })
    await scheduled[0]()
    expect(review).toHaveBeenCalledWith({ tenantId: "t", applicationId: "a" })
  })

  it("a failing review is logged and never thrown: the application stays with staff", async () => {
    review.mockReset().mockRejectedValue(new Error("db down"))
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const scheduled: Array<() => Promise<void>> = []
    scheduleDigitalDecision({ tenantId: "t", applicationId: "a" }, (task) => { scheduled.push(task) })
    await expect(scheduled[0]()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
