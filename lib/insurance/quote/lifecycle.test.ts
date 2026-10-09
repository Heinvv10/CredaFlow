import { describe, expect, it } from "vitest"
import { QuoteStatus } from "@prisma/client"
import {
  BIND_ONLY_STATUSES,
  STATUSES_REQUIRING_ADVICE,
  TERMINAL_STATUSES,
  canTransition,
  nextStatuses,
} from "./lifecycle"

// A quote that priced and passed screening. DRAFT -> QUOTED now consults the
// quote's own persisted evidence, so these facts have to be supplied.
const SELLABLE = { eligibilityPassed: true, hasPrice: true } as const
const WITH_ADVICE = { hasAdviceRecord: true, ...SELLABLE } as const
const NO_ADVICE = { hasAdviceRecord: false, ...SELLABLE } as const

describe("the transition table covers the schema", () => {
  it("knows every QuoteStatus the enum declares", () => {
    // The table is a Record<QuoteStatus, …>, so a status added to the schema
    // fails the type check. This asserts the runtime side of the same thing:
    // every status is reachable by `nextStatuses` without throwing.
    for (const status of Object.values(QuoteStatus)) {
      expect(() => nextStatuses(status, WITH_ADVICE)).not.toThrow()
    }
  })

  it("treats exactly REJECTED, CONVERTED and EXPIRED as terminal", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["CONVERTED", "EXPIRED", "REJECTED"])
  })
})

describe("transitions are one-directional", () => {
  it("refuses every backward move", () => {
    const backward: [QuoteStatus, QuoteStatus][] = [
      ["QUOTED", "DRAFT"],
      ["ADVICE_RECORDED", "QUOTED"],
      ["SUBMITTED_TO_INSURER", "ADVICE_RECORDED"],
      ["ACCEPTED", "SUBMITTED_TO_INSURER"],
      ["ACCEPTED", "DRAFT"],
    ]
    for (const [from, to] of backward) {
      expect(canTransition(from, to, WITH_ADVICE)).toMatchObject({ ok: false, reason: "NOT_ALLOWED" })
    }
  })

  it("refuses to re-open a terminal quote", () => {
    for (const from of TERMINAL_STATUSES) {
      // A change of mind after rejection is a NEW quote: re-opening this one
      // would let the price the client was shown be rewritten after the fact.
      expect(canTransition(from, "QUOTED", WITH_ADVICE)).toMatchObject({
        ok: false,
        reason: "TERMINAL_STATUS",
      })
      expect(nextStatuses(from, WITH_ADVICE)).toEqual([])
    }
  })

  it("refuses a no-op transition rather than reporting success", () => {
    expect(canTransition("QUOTED", "QUOTED", WITH_ADVICE)).toMatchObject({
      ok: false,
      reason: "SAME_STATUS",
    })
  })

  it("allows the forward path once advice exists", () => {
    expect(canTransition("DRAFT", "QUOTED", NO_ADVICE).ok).toBe(true)
    expect(canTransition("QUOTED", "ADVICE_RECORDED", WITH_ADVICE).ok).toBe(true)
    expect(canTransition("ADVICE_RECORDED", "SUBMITTED_TO_INSURER", WITH_ADVICE).ok).toBe(true)
    expect(canTransition("SUBMITTED_TO_INSURER", "ACCEPTED", WITH_ADVICE).ok).toBe(true)
  })
})

describe("CONVERTED is set only by the bind", () => {
  it("refuses an API caller even from ACCEPTED, where it is otherwise allowed", () => {
    // The point of the case: this is NOT a "wrong source status" refusal. The
    // move is legal; the caller is not entitled to make it.
    expect(canTransition("ACCEPTED", "CONVERTED", { ...WITH_ADVICE, via: "API" })).toMatchObject({
      ok: false,
      reason: "BIND_ONLY",
    })
  })

  it("defaults an unspecified caller to the constrained one", () => {
    // A caller that forgets to declare how it is transitioning must get the
    // narrower permission, never the wider.
    expect(canTransition("ACCEPTED", "CONVERTED", WITH_ADVICE)).toMatchObject({
      ok: false,
      reason: "BIND_ONLY",
    })
  })

  it("allows the bind path itself", () => {
    expect(canTransition("ACCEPTED", "CONVERTED", { ...WITH_ADVICE, via: "BIND" }).ok).toBe(true)
  })

  it("still refuses the bind from a status that has not been accepted", () => {
    expect(canTransition("QUOTED", "CONVERTED", { ...WITH_ADVICE, via: "BIND" })).toMatchObject({
      ok: false,
      reason: "NOT_ALLOWED",
    })
  })

  it("omits CONVERTED from what an API caller may do next", () => {
    expect(nextStatuses("ACCEPTED", { ...WITH_ADVICE, via: "API" })).toEqual(["EXPIRED"])
    expect(BIND_ONLY_STATUSES).toEqual(["CONVERTED"])
  })
})

describe("the FAIS record of advice is a precondition", () => {
  it("blocks every status at or past ADVICE_RECORDED when there is no record", () => {
    for (const to of STATUSES_REQUIRING_ADVICE) {
      // Checked against each status's own legal predecessor, so the refusal
      // can only be about the missing advice and never about the source.
      const from: QuoteStatus =
        to === "ADVICE_RECORDED" ? "QUOTED"
        : to === "SUBMITTED_TO_INSURER" ? "ADVICE_RECORDED"
        : to === "ACCEPTED" ? "SUBMITTED_TO_INSURER"
        : "ACCEPTED"
      const via = to === "CONVERTED" ? ("BIND" as const) : ("API" as const)

      expect(canTransition(from, to, { hasAdviceRecord: false, via })).toMatchObject({
        ok: false,
        reason: "ADVICE_REQUIRED",
      })
    }
  })

  it("does not require advice for the moves that precede it", () => {
    expect(canTransition("DRAFT", "QUOTED", NO_ADVICE).ok).toBe(true)
    expect(canTransition("DRAFT", "EXPIRED", NO_ADVICE).ok).toBe(true)
  })

  it("lets an unadvised quote still be rejected or expired", () => {
    // Abandoning a quote must never be blocked by a control designed to stop it
    // ADVANCING — that would strand it as un-closeable.
    expect(canTransition("QUOTED", "REJECTED", NO_ADVICE).ok).toBe(true)
    expect(canTransition("QUOTED", "EXPIRED", NO_ADVICE).ok).toBe(true)
    expect(nextStatuses("QUOTED", NO_ADVICE)).toEqual(["REJECTED", "EXPIRED"])
  })
})

describe("DRAFT -> QUOTED is gated on the quote's own evidence", () => {
  // The B2 laundering path. `createQuote` refuses to WRITE a QUOTED row for a
  // quote that failed rating or screening; that guarded the WRITER. This guards
  // the STATE, so a later PATCH cannot set the status the writer refused.
  it("refuses when the quote failed the insurer's acceptance terms", () => {
    expect(canTransition("DRAFT", "QUOTED", { hasAdviceRecord: false, eligibilityPassed: false, hasPrice: true }))
      .toMatchObject({ ok: false, reason: "NOT_SELLABLE" })
  })

  it("refuses when the quote carries no price", () => {
    expect(canTransition("DRAFT", "QUOTED", { hasAdviceRecord: false, eligibilityPassed: true, hasPrice: false }))
      .toMatchObject({ ok: false, reason: "NOT_SELLABLE" })
  })

  it("defaults BOTH facts to false, so a caller that omits them cannot promote", () => {
    // Fail-closed: forgetting to pass the evidence must not read as the
    // evidence being favourable.
    expect(canTransition("DRAFT", "QUOTED", { hasAdviceRecord: false }))
      .toMatchObject({ ok: false, reason: "NOT_SELLABLE" })
  })

  it("allows it only when the quote both priced and passed", () => {
    expect(canTransition("DRAFT", "QUOTED", { hasAdviceRecord: false, eligibilityPassed: true, hasPrice: true }).ok)
      .toBe(true)
  })

  it("never blocks abandoning a DRAFT", () => {
    expect(canTransition("DRAFT", "REJECTED", { hasAdviceRecord: false }).ok).toBe(true)
    expect(canTransition("DRAFT", "EXPIRED", { hasAdviceRecord: false }).ok).toBe(true)
  })
})
