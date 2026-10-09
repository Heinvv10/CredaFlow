import { describe, expect, it } from "vitest"
import { canConvertLead, leadConversionState, leadPipelineStatus } from "./lead-conversion"

describe("lead conversion state", () => {
  it.each([
    ["QUALIFIED", null, null, false, "OPEN", "QUALIFIED", true],
    ["CONVERTED", null, null, true, "STRANDED", "STRANDED", false],
    ["CONVERTED", "client-1", null, true, "INCOMPLETE", "INCOMPLETE", false],
    ["CONVERTED", "client-1", "app-1", false, "COMPLETE", "CONVERTED", false],
    ["CONVERTED", "client-1", "app-1", true, "INCOMPLETE", "INCOMPLETE", false],
    ["QUALIFIED", "client-1", null, false, "INCOMPLETE", "INCOMPLETE", false],
    ["CONVERTED", "client-1", null, false, "INCOMPLETE", "INCOMPLETE", false],
    ["CONVERTED", null, "app-1", false, "INCOMPLETE", "INCOMPLETE", false],
    ["QUALIFIED", "client-1", "app-1", false, "INCOMPLETE", "INCOMPLETE", false],
  ])(
    "maps status=%s client=%s application=%s recovery=%s to %s",
    (status, clientId, applicationId, recoveryRequired, expectedState, expectedStatus, expectedCanConvert) => {
      expect(leadConversionState(status, clientId, applicationId, recoveryRequired)).toBe(expectedState)
      expect(leadPipelineStatus(status, clientId, applicationId, recoveryRequired)).toBe(expectedStatus)
      expect(canConvertLead(status, clientId, applicationId, recoveryRequired)).toBe(expectedCanConvert)
    },
  )
})
