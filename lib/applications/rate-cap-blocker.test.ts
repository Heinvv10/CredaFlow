import { afterEach, describe, expect, it, vi } from "vitest"

const { check } = vi.hoisted(() => ({ check: vi.fn() }))
vi.mock("@/lib/loan/nca-interest-cap.server", () => ({ approvalInterestCapCheck: check }))

import { rateCapBlocker } from "./rate-cap-blocker"
import { headerBlockerLabel } from "./rail-blockers"

const db = {} as never
const app = (status = "UNDER_REVIEW") => ({ status }) as never

afterEach(() => { check.mockReset(); vi.restoreAllMocks() })

// Fair Score acceptance (2026-10-17): the rail answered "Approval blocked: 36.00% per
// year exceeds the NCA maximum" while the header said NO BLOCKERS.
describe("rateCapBlocker", () => {
  it("lists a rate above the cap as a danger blocker the header counts", async () => {
    const message = "36.00% per year exceeds the NCA maximum of 29.25% (Regulation 42)."
    check.mockResolvedValue({ ok: false, reason: "ABOVE_CAP", message })
    const blocker = await rateCapBlocker(db, "t1", app())
    expect(blocker).toEqual({ label: "Rate exceeds NCA cap", detail: message, tone: "danger" })
    expect(headerBlockerLabel([blocker!])).toBe("1 blocker")
    expect(check).toHaveBeenCalledWith(db, "t1", expect.objectContaining({ status: "UNDER_REVIEW" }))
  })

  it.each([
    ["NO_REPO_RATE", "Repo rate not recorded"],
    ["REPO_IMPLAUSIBLE", "Repo rate implausible"],
    ["REPEAT_SHORT_TERM", "Repeat short-term rate exceeds NCA cap"],
  ])("labels a %s refusal by its own cause", async (reason, label) => {
    check.mockResolvedValue({ ok: false, reason, message: "why" })
    expect(await rateCapBlocker(db, "t1", app())).toMatchObject({ label, detail: "why" })
  })

  it("is null when the rate is within the cap", async () => {
    check.mockResolvedValue({ ok: true })
    expect(await rateCapBlocker(db, "t1", app())).toBeNull()
  })

  it.each(["DRAFT", "SUBMITTED", "APPROVED", "DECLINED"])("does not run the check for a %s application", async (status) => {
    expect(await rateCapBlocker(db, "t1", app(status))).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })

  it("lists the gate as unchecked, and logs, when the check throws, rather than failing the page", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const failure = new Error("db down")
    check.mockRejectedValue(failure)
    expect(await rateCapBlocker(db, "t1", app())).toMatchObject({ label: "NCA rate cap could not be checked", tone: "warning" })
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("rate cap check failed"), failure)
  })
})
