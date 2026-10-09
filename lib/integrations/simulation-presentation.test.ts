import { describe, expect, it } from "vitest"
import {
  integrationTestResultMessage,
  notificationLogDisplayStatus,
} from "./simulation-presentation"

describe("integration simulation presentation", () => {
  it("does not call a dry-run connection test a real send", () => {
    expect(integrationTestResultMessage({ ok: true, simulated: true })).toBe(
      "Simulation successful — the provider was not contacted",
    )
    expect(integrationTestResultMessage({ ok: true })).toBe("Connection successful")
  })

  it("renders simulated notification logs distinctly from sent and failed", () => {
    expect(notificationLogDisplayStatus("simulated")).toEqual({
      label: "Simulated — not sent",
      tone: "simulation",
    })
    expect(notificationLogDisplayStatus("sent").tone).toBe("success")
    expect(notificationLogDisplayStatus("ok").tone).toBe("success")
    expect(notificationLogDisplayStatus("failed").tone).toBe("failure")
  })
})
