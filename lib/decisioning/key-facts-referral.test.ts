import { describe, expect, it } from "vitest"
import { keyFactsReferral } from "./key-facts-referral"
import { facts } from "./facts.test-helpers"
import type { RuleDef } from "./types"

const rule = (field: string, op = "lt", value: number | boolean = 560): RuleDef =>
  ({ id: "r1", name: "R1", outcome: "KNOCK_OUT", reasonCode: "R_ONE", declineCategory: "POLICY", when: { field, op, value } }) as RuleDef

describe("keyFactsReferral", () => {
  it("never refers an NCA_PASQ application (the staff approval path refuses a missing bureau itself)", () => {
    expect(keyFactsReferral({ regime: "NCA_PASQ", bureauCheckId: null, facts: facts({ bureauScore: null }), rules: [rule("bureauScore")] })).toBeNull()
  })

  it("refers a KEY_FACTS application with no bureau check: its bureau rules passed because they never fired", () => {
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: null, facts: facts({ bureauScore: null }), rules: [] })).toEqual({ reasonCode: "NO_BUREAU", note: expect.stringContaining("bureau") })
  })

  it("refers a KEY_FACTS application when a rule compares a fact that is missing, even with a bureau check", () => {
    const result = keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: 640, instalmentCents: null }), rules: [rule("bureauScore"), rule("instalmentCents", "gt", 1)] })
    expect(result).toEqual({ reasonCode: "MISSING_FACT", note: expect.stringContaining("instalmentCents") })
  })

  it("lets a rule test for a missing fact on purpose (isNull / notNull) and passes when every compared fact is known", () => {
    const isNull = { id: "r2", name: "R2", outcome: "REFER", reasonCode: "R_TWO", when: { field: "bureauScore", op: "isNull" } } as RuleDef
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: null }), rules: [isNull] })).toBeNull()
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: 640 }), rules: [rule("bureauScore")] })).toBeNull()
  })

  it("looks inside all/any groups", () => {
    const grouped = { id: "g", name: "G", outcome: "REFER", reasonCode: "G", when: { all: [{ any: [{ field: "bureauScore", op: "lt", value: 500 }] }] } } as RuleDef
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: null }), rules: [grouped] })).toMatchObject({ reasonCode: "MISSING_FACT" })
  })
})
