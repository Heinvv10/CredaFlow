import { describe, expect, it } from "vitest"
import { CAMERA_FAILURE_MESSAGES, cameraFailure } from "./camera-error"

const domError = (name: string) => Object.assign(new Error("Requested device not found"), { name })

describe("cameraFailure", () => {
  it.each([
    ["NotAllowedError", "blocked"],
    ["NotFoundError", "no_camera"],
    ["OverconstrainedError", "no_camera"],
    ["NotReadableError", "busy"],
    ["SecurityError", "insecure"],
    ["TypeError", "insecure"],
    ["SomethingElse", "other"],
  ])("reads %s as %s", (name, failure) => {
    expect(cameraFailure(domError(name))).toBe(failure)
  })

  it("never echoes the browser's message", () => {
    for (const message of Object.values(CAMERA_FAILURE_MESSAGES)) expect(message).not.toContain("Requested device")
  })
})
