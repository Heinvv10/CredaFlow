import { describe, expect, it } from "vitest"
import { valueDatePayload, valueDatePrompt } from "./value-date-payload"

const TODAY = "2026-07-24"

describe("valueDatePrompt", () => {
  it("asks for nothing on a same-day capture", () => {
    expect(valueDatePrompt({
      receivedAt: TODAY,
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toBe("none")
  })

  it("asks for nothing when the date is left blank", () => {
    expect(valueDatePrompt({
      receivedAt: "",
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toBe("none")
  })

  it("offers the reason field to a user who may authorise a back-date", () => {
    expect(valueDatePrompt({
      receivedAt: "2026-07-14",
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toBe("override_reason")
  })

  it("warns, rather than offering the field, when the user may not authorise", () => {
    // The reason box records a senior authorisation. Showing it to someone who
    // cannot give one invites a 403 and misrepresents who approved what.
    expect(valueDatePrompt({
      receivedAt: "2026-07-14",
      canAuthoriseBackdate: false,
      today: TODAY,
    })).toBe("authorisation_warning")
  })

  it("never treats a future date as a back-date", () => {
    expect(valueDatePrompt({
      receivedAt: "2026-07-25",
      canAuthoriseBackdate: false,
      today: TODAY,
    })).toBe("none")
  })
})

describe("valueDatePayload", () => {
  it("omits the date entirely when staff leave it blank", () => {
    // The API reads absent as "today"; an empty string fails its date parse and
    // would reject an ordinary same-day capture outright.
    expect(valueDatePayload({
      receivedAt: "",
      overrideReason: "",
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toEqual({})
  })

  it("sends a back-dated value date without a reason when none was given", () => {
    // Most back-dating is an ordinary capture lag and stands unreviewed.
    expect(valueDatePayload({
      receivedAt: "2026-07-14",
      overrideReason: "",
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toEqual({ receivedAt: "2026-07-14" })
  })

  it("attaches the override reason for a user who may authorise one", () => {
    expect(valueDatePayload({
      receivedAt: "2026-07-14",
      overrideReason: "  Branch cash banked 14 July, receipt found in the safe  ",
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toEqual({
      receivedAt: "2026-07-14",
      valueDateOverrideReason:
        "Branch cash banked 14 July, receipt found in the safe",
    })
  })

  it("withholds a reason from a user who may not authorise one", () => {
    // Sending it anyway turns a capture into a 403 rather than the ordinary
    // unreviewed back-date it may well be.
    expect(valueDatePayload({
      receivedAt: "2026-07-14",
      overrideReason: "Branch cash banked on the 14th of July",
      canAuthoriseBackdate: false,
      today: TODAY,
    })).toEqual({ receivedAt: "2026-07-14" })
  })

  it("withholds a reason on a same-day capture", () => {
    // No back-dating happened, so recording an authorisation would assert an
    // exception that never occurred.
    expect(valueDatePayload({
      receivedAt: TODAY,
      overrideReason: "Branch cash banked on the 14th of July",
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toEqual({ receivedAt: TODAY })
  })

  it("treats a whitespace-only reason as no reason", () => {
    expect(valueDatePayload({
      receivedAt: "2026-07-14",
      overrideReason: "   \n  ",
      canAuthoriseBackdate: true,
      today: TODAY,
    })).toEqual({ receivedAt: "2026-07-14" })
  })
})
