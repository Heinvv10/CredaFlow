import { beforeEach, describe, expect, it, vi } from "vitest"

const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock("@/lib/observability/logger", () => ({ logger: { error: log.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { BUSY_ALERT_PASSES, noteBusy } from "./chainer"

beforeEach(() => { log.error.mockClear(); noteBusy("t-reset", false); noteBusy("t1", false); noteBusy("t2", false) })

describe("the busy-chain alert", () => {
  it("says so once a chain has been held by another chainer for too many passes in a row", () => {
    for (let i = 1; i < BUSY_ALERT_PASSES; i++) noteBusy("t1", true)
    expect(log.error).not.toHaveBeenCalled()
    noteBusy("t1", true)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("held by another chainer"), { chainKey: "t1", passes: BUSY_ALERT_PASSES })
    for (let i = 0; i < 50; i++) noteBusy("t1", true) // once, not on every pass
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it("starts counting again after a pass that was not held, and counts each chain apart", () => {
    for (let i = 1; i < BUSY_ALERT_PASSES; i++) { noteBusy("t1", true); noteBusy("t2", true) }
    noteBusy("t1", false)
    noteBusy("t1", true)
    noteBusy("t2", true)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ chainKey: "t2" }))
  })
})
