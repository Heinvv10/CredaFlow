import { describe, it, expect, afterEach } from "vitest"
import {
  isPortalForgotNewSendEnabled,
  isSection129NewSendEnabled,
  isCollectionsNewSendEnabled,
} from "./flags"

describe("isPortalForgotNewSendEnabled", () => {
  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT
  })

  it("returns true only for the exact string 'true'", () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    expect(isPortalForgotNewSendEnabled()).toBe(true)
  })

  it("returns false when env var is unset", () => {
    delete process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT
    expect(isPortalForgotNewSendEnabled()).toBe(false)
  })

  it("returns false for 'false'", () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "false"
    expect(isPortalForgotNewSendEnabled()).toBe(false)
  })

  it("returns false for case-variant 'TRUE' (strict match)", () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "TRUE"
    expect(isPortalForgotNewSendEnabled()).toBe(false)
  })

  it("returns false for '1'", () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "1"
    expect(isPortalForgotNewSendEnabled()).toBe(false)
  })

  it("returns false for empty string", () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = ""
    expect(isPortalForgotNewSendEnabled()).toBe(false)
  })
})

describe("isSection129NewSendEnabled", () => {
  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_S129
  })

  it("returns true only for the exact string 'true'", () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    expect(isSection129NewSendEnabled()).toBe(true)
  })

  it("returns false when env var is unset", () => {
    delete process.env.MESSAGING_NEW_SEND_S129
    expect(isSection129NewSendEnabled()).toBe(false)
  })

  it("returns false for 'false', '1', 'TRUE', empty (strict match)", () => {
    for (const val of ["false", "1", "TRUE", ""]) {
      process.env.MESSAGING_NEW_SEND_S129 = val
      expect(isSection129NewSendEnabled()).toBe(false)
    }
  })
})

describe("isCollectionsNewSendEnabled", () => {
  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
  })

  it("returns true only for the exact string 'true'", () => {
    process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
    expect(isCollectionsNewSendEnabled()).toBe(true)
  })

  it("returns false when env var is unset", () => {
    delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
    expect(isCollectionsNewSendEnabled()).toBe(false)
  })

  it("returns false for 'false', '1', 'TRUE', empty (strict match)", () => {
    for (const val of ["false", "1", "TRUE", ""]) {
      process.env.MESSAGING_NEW_SEND_COLLECTIONS = val
      expect(isCollectionsNewSendEnabled()).toBe(false)
    }
  })
})
