// @vitest-environment node
// Node env (not jsdom) so `globalThis.window` is genuinely absent by default —
// the "server render" case below must exercise the real SSR branch, not a
// jsdom-provided window.
import { afterEach, describe, expect, it } from "vitest"

import {
  trackApplyStart,
  trackApplySubmit,
  trackEvent,
  trackQualifyResult,
  trackRegisterActivated,
  trackRegisterCodeSent,
  trackRegisterStart,
} from "@/lib/analytics/events"

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
})

describe("trackEvent", () => {
  it("pushes a trackEvent tuple onto window._paq, omitting trailing undefined args", () => {
    const _paq: unknown[] = []
    Object.assign(globalThis, { window: { _paq } })

    trackEvent("funnel", "apply_start")
    trackEvent("funnel", "qualify_result", "qualified")
    trackEvent("funnel", "custom", "name", 42)

    expect(_paq).toEqual([
      ["trackEvent", "funnel", "apply_start"],
      ["trackEvent", "funnel", "qualify_result", "qualified"],
      ["trackEvent", "funnel", "custom", "name", 42],
    ])
  })

  it("no-ops without throwing when window._paq is not an array (analytics disabled)", () => {
    Object.assign(globalThis, { window: {} })

    expect(() => trackEvent("funnel", "apply_start")).not.toThrow()
  })

  it("no-ops without throwing when window is undefined (server render)", () => {
    expect(() => trackEvent("funnel", "apply_start")).not.toThrow()
  })

  it("swallows a throwing _paq.push so a broken tracker never breaks the funnel", () => {
    const push = () => {
      throw new Error("hostile tracker")
    }
    Object.assign(globalThis, { window: { _paq: Object.assign([], { push }) } })

    expect(() => trackEvent("funnel", "apply_start")).not.toThrow()
  })
})

describe("funnel event wrappers", () => {
  it("fire the expected category/action/name onto window._paq", () => {
    const _paq: unknown[] = []
    Object.assign(globalThis, { window: { _paq } })

    trackApplyStart()
    trackApplySubmit()
    trackQualifyResult("declined")

    expect(_paq).toEqual([
      ["trackEvent", "funnel", "apply_start"],
      ["trackEvent", "funnel", "apply_submit"],
      ["trackEvent", "funnel", "qualify_result", "declined"],
    ])
  })

  it("fire the register (portal activation) funnel events in two-step order", () => {
    const _paq: unknown[] = []
    Object.assign(globalThis, { window: { _paq } })

    trackRegisterStart()
    trackRegisterCodeSent()
    trackRegisterActivated()

    expect(_paq).toEqual([
      ["trackEvent", "funnel", "register_start"],
      ["trackEvent", "funnel", "register_code_sent"],
      ["trackEvent", "funnel", "register_activated"],
    ])
  })
})
