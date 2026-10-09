import { describe, it, expect, afterEach } from "vitest"
import { isSmsChannelEnabled } from "./sms-channel"

describe("isSmsChannelEnabled", () => {
  afterEach(() => {
    delete process.env.BULKSMS_DRY_RUN
  })

  it("is off for the exact string 'true' — the condition prod runs", () => {
    process.env.BULKSMS_DRY_RUN = "true"
    expect(isSmsChannelEnabled()).toBe(false)
  })

  it("is on when the flag is unset", () => {
    delete process.env.BULKSMS_DRY_RUN
    expect(isSmsChannelEnabled()).toBe(true)
  })

  it("is on for 'false', '1', 'TRUE', empty — strict match, mirroring getChannelAvailability", () => {
    for (const val of ["false", "1", "TRUE", ""]) {
      process.env.BULKSMS_DRY_RUN = val
      expect(isSmsChannelEnabled(), `BULKSMS_DRY_RUN="${val}"`).toBe(true)
    }
  })

  it("does NOT key off NODE_ENV — folding in bulksms.ts's test arm would switch the channel off for the whole suite", () => {
    delete process.env.BULKSMS_DRY_RUN
    expect(process.env.NODE_ENV).toBe("test")
    expect(isSmsChannelEnabled()).toBe(true)
  })
})
