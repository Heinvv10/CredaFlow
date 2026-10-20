import { describe, it, expect, afterEach } from "vitest"
import { isSmsChannelEnabled } from "./sms-channel"

describe("isSmsChannelEnabled", () => {
  afterEach(() => {
    delete process.env.BULKSMS_DRY_RUN
  })

  it("is OFF when the env var is unset — SMS is off by policy, so the default must be off", () => {
    delete process.env.BULKSMS_DRY_RUN
    expect(isSmsChannelEnabled()).toBe(false)
  })

  it("is off for the exact string 'true' — the condition prod runs", () => {
    process.env.BULKSMS_DRY_RUN = "true"
    expect(isSmsChannelEnabled()).toBe(false)
  })

  it("is on only for the exact string 'false' — an explicit opt-in", () => {
    process.env.BULKSMS_DRY_RUN = "false"
    expect(isSmsChannelEnabled()).toBe(true)
  })

  it("is off for every other value: '1', 'TRUE', 'False', 'no', empty, whitespace", () => {
    for (const val of ["1", "TRUE", "False", "no", "", " "]) {
      process.env.BULKSMS_DRY_RUN = val
      expect(isSmsChannelEnabled(), `BULKSMS_DRY_RUN="${val}"`).toBe(false)
    }
  })

  it("does NOT key off NODE_ENV — folding in bulksms.ts's test arm would make the channel's on-state untestable", () => {
    process.env.BULKSMS_DRY_RUN = "false"
    expect(process.env.NODE_ENV).toBe("test")
    expect(isSmsChannelEnabled()).toBe(true)
  })
})
