import { describe, it, expect } from "vitest"
import { PUBLIC_COMMS_SETTINGS_SELECT } from "./comms-select"

// The columns updateCommsSettings runs through sealWabaField. Listed here
// independently of the select itself so this assertion can actually fail.
const SEALED_COLUMNS = ["wabaAccessToken", "wabaAppSecret", "wabaVerifyToken"]

describe("PUBLIC_COMMS_SETTINGS_SELECT", () => {
  it("selects no sealed credential column", () => {
    const selected = Object.keys(PUBLIC_COMMS_SETTINGS_SELECT)
    for (const column of SEALED_COLUMNS) {
      expect(selected).not.toContain(column)
    }
  })

  it("still selects the public connection identifiers the settings page renders", () => {
    expect(PUBLIC_COMMS_SETTINGS_SELECT).toEqual({ waProvider: true, wabaPhoneNumberId: true })
  })
})
