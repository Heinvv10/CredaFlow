import { describe, expect, it } from "vitest"
import { formatRands } from "@/lib/utils"
import {
  FIELD_NAMES,
  LABELS,
  ADD_VEHICLE_GATE_FIELDS,
  amountRangeHint,
  arrivalPlan,
  buildSteps,
  canAddVehicle,
  shouldHoldForResort,
  MAX_VEHICLES,
  POLICY_FIELDS,
  REQUIRED_FIELDS_BY_VIEW,
  FIELD_KINDS,
  WIZARD_STEPS_BY_VIEW,
  acceptsNumber,
  askedFields,
  CHECK_AFFIRMATIVES,
  summaryValue,
  isUnanswered,
  VEHICLE_FIELDS,
  WAITING_STAGES,
  WIZARD_STEPS,
  detailsFromSaIdNumber,
  furthestReachableStep,
  missingFields,
  parsePremium,
  stepProgress,
  summariseQuotes,
  settleDelay,
  sortQuotes,
  tidyInsurerName,
  waitingStage,
  type QuickQuoteField,
} from "./quickquote-bridge"

describe("detailsFromSaIdNumber", () => {
  // Deliberately synthetic: 1 Jan 1980, sequence 5000, Luhn-valid. An earlier
  // version used a number lifted from a screenshot which turned out to
  // identify a real person — a third-party insurer database resolved it to
  // their live contact details. Test fixtures must not be real identifiers.
  const VALID_MALE = "8001015000086"

  it("derives birth year and gender from a valid ID", () => {
    expect(detailsFromSaIdNumber(VALID_MALE, 2026)).toEqual({
      birthYear: 1980,
      gender: "Male",
    })
  })

  it("tolerates spacing", () => {
    expect(detailsFromSaIdNumber(" 8001 0150 00086 ", 2026)).toMatchObject({
      birthYear: 1980,
    })
  })

  // The reference year is a parameter so the result is deterministic — the
  // same inputs always give the same answer, rather than quietly shifting as
  // the wall clock advances mid-session or between server and client.
  it("is deterministic for a given reference year", () => {
    expect(detailsFromSaIdNumber(VALID_MALE, 2026)).toEqual(
      detailsFromSaIdNumber(VALID_MALE, 2026),
    )
  })

  // Century resolution SHOULD depend on the reference year: "78" means 1978 to
  // someone quoting in 2026, but would mean 2078 to someone quoting in 2099.
  // Picking the most recent century that yields an adult is the only rule that
  // stays right in both.
  it.each([
    [2026, 1980],
    [2050, 1980],
    [2099, 2080],
  ])("in %i reads a '80 ID as born %i", (reference, expected) => {
    expect(detailsFromSaIdNumber(VALID_MALE, reference)?.birthYear).toBe(expected)
  })

  // Nobody insures a car in their first year, so the current century must not
  // be chosen when it would imply a child.
  it("never derives a birth year that implies someone under 16", () => {
    const derived = detailsFromSaIdNumber("2401015000083", 2026)
    if (derived) expect(2026 - derived.birthYear).toBeGreaterThanOrEqual(16)
  })

  it.each([
    ["too short", "800101500008"],
    ["too long", "80010150000861"],
    ["non-numeric", "80010150000ab"],
    ["empty", ""],
    ["month 00", "8000015000082"],
    ["month 13", "8013015000080"],
    ["day 00", "8001005000087"],
    ["day 32", "8001325000085"],
  ])("returns null for %s", (_label, id) => {
    expect(detailsFromSaIdNumber(id, 2026)).toBeNull()
  })

  // Without the check digit a mistyped ID silently yields a wrong birth year
  // and gender, which then get submitted to insurers as fact.
  it("rejects an ID that fails the Luhn check digit", () => {
    expect(detailsFromSaIdNumber("8001015000087", 2026)).toBeNull()
  })

  it("reads the gender sequence, not the check digit", () => {
    const male = detailsFromSaIdNumber(VALID_MALE, 2026)
    expect(male?.gender).toBe("Male")
    // Same date, sequence below 5000 → female. Check digit recomputed.
    const female = detailsFromSaIdNumber("8001010000081", 2026)
    expect(female?.gender).toBe("Female")
  })
})

describe("missingFields", () => {
  const REQUIRED_FIELDS = REQUIRED_FIELDS_BY_VIEW.motor
  const allPresent = REQUIRED_FIELDS.map((f) => FIELD_NAMES[f])

  it("reports nothing missing when FSP served every field", () => {
    expect(missingFields(allPresent, "motor")).toEqual([])
  })

  // FSP change their markup without notice. The wizard must detect that and
  // hand back to their own form rather than trap the visitor behind ours.
  it.each(REQUIRED_FIELDS)("detects %s missing", (field) => {
    const partial = allPresent.filter((n) => n !== FIELD_NAMES[field])
    expect(missingFields(partial, "motor")).toContain(field)
  })

  it("reports every required field when the form is absent entirely", () => {
    expect(missingFields([], "motor")).toHaveLength(REQUIRED_FIELDS.length)
  })

  it("ignores extra fields FSP may add", () => {
    expect(missingFields([...allPresent, "SomethingNew"], "motor")).toEqual([])
  })
})

describe("per-view field maps", () => {
  const VIEWS = ["motor", "home", "building"] as const

  it("keeps motor's required set exactly as it was", () => {
    expect(REQUIRED_FIELDS_BY_VIEW.motor).toEqual([
      "birthYear",
      "gender",
      "maritalStatus",
      "suburb",
      "vehicleYear",
      "make",
      "model",
      "vehicleUse",
      "overnightParking",
      "lastClaim",
      "licenceYear",
      "licenceType",
    ])
  })

  it("requires the four policyholder fields plus the two priced home fields", () => {
    expect(REQUIRED_FIELDS_BY_VIEW.home).toEqual([
      "birthYear",
      "gender",
      "maritalStatus",
      "suburb",
      "contentsValue",
      "movedInYear",
    ])
  })

  it("requires the four policyholder fields plus the building value", () => {
    expect(REQUIRED_FIELDS_BY_VIEW.building).toEqual([
      "birthYear",
      "gender",
      "maritalStatus",
      "suburb",
      "buildingValue",
    ])
  })

  // The whole point of excluding them: an unticked alarm is an ANSWER.
  // Requiring it would force every visitor to claim a security feature, or a
  // burglary, they may not have — a misstatement on an insurance application,
  // not merely an awkward screen.
  it("never requires a checkbox on any view", () => {
    for (const view of VIEWS) {
      for (const field of REQUIRED_FIELDS_BY_VIEW[view]) {
        expect(FIELD_KINDS[field].control).not.toBe("checkbox")
      }
    }
  })

  /* `FIELD_KINDS` and `LABELS` are exhaustive Records over QuickQuoteField, so
     asserting a member is merely DEFINED cannot fail — the type system already
     guarantees it for any step list that compiles. These assert the properties
     that are NOT guaranteed: that the label is a real question rather than an
     empty string, and that a checkbox's affirmative text exists. */
  it("gives every asked field a non-empty, human label", () => {
    for (const view of VIEWS) {
      for (const field of askedFields(view)) {
        expect(LABELS[field].trim().length).toBeGreaterThan(0)
      }
    }
  })

  /* The affirmative is what the visitor actually reads beside the tick box, and
     it is copied from FSP's own label so our question and their recorded risk
     cannot drift. A checkbox added without one renders an unlabelled box next
     to a risk question — this is why the map lives here, beside LABELS, rather
     than in the component where no test could reach it. */
  it("gives every checkbox an affirmative taken from FSP's own label", () => {
    for (const view of VIEWS) {
      for (const field of askedFields(view)) {
        if (FIELD_KINDS[field].control !== "checkbox") continue
        const text = CHECK_AFFIRMATIVES[field as keyof typeof CHECK_AFFIRMATIVES]
        expect(text.trim().length).toBeGreaterThan(0)
        expect(text.toLowerCase().startsWith("yes")).toBe(true)
      }
    }
  })

  it("declares a number field's bounds in a usable order", () => {
    for (const view of VIEWS) {
      for (const field of askedFields(view)) {
        const kind = FIELD_KINDS[field]
        if (kind.control !== "number") continue
        expect(kind.min).toBeGreaterThan(0)
        expect(kind.max).toBeGreaterThan(kind.min)
        expect(kind.step).toBeGreaterThan(0)
      }
    }
  })

  it("asks every required field somewhere in the view's steps", () => {
    for (const view of VIEWS) {
      const asked = WIZARD_STEPS_BY_VIEW[view].flatMap((s) => s.fields)
      for (const field of REQUIRED_FIELDS_BY_VIEW[view]) {
        expect(asked).toContain(field)
      }
    }
  })

  it("asks nothing twice within a view", () => {
    for (const view of VIEWS) {
      const asked = WIZARD_STEPS_BY_VIEW[view].flatMap((s) => s.fields)
      expect(new Set(asked).size).toBe(asked.length)
    }
  })

  // buildSteps returns this identity for a one-car journey, which is what
  // makes the flag-off regression floor provable rather than equal-for-now.
  it("is motor's own step list, by identity", () => {
    expect(WIZARD_STEPS_BY_VIEW.motor).toBe(WIZARD_STEPS)
  })

  it("reports a home field as missing when FSP did not serve it", () => {
    const present = [
      "DOBYear",
      "Gender",
      "MaritialStatus",
      "SuburbMatch",
      "homecontentsvalue",
      "burglary",
      "alarm",
    ]
    expect(missingFields(present, "home")).toEqual(["movedInYear"])
  })

  // The reason the view parameter exists: a home form has no licence or
  // LastClaim control, and measuring it against motor's twelve fields handed
  // every home visitor straight back to FSP's own UI.
  it("does not fault a home form for lacking motor's fields", () => {
    const present = [
      "DOBYear",
      "Gender",
      "MaritialStatus",
      "SuburbMatch",
      "homecontentsvalue",
      "HomeContentYear",
      "burglary",
      "alarm",
    ]
    expect(missingFields(present, "home")).toEqual([])
  })

  it("does not fault a building form for lacking motor's fields", () => {
    const present = [
      "DOBYear",
      "Gender",
      "MaritialStatus",
      "SuburbMatch",
      "buildingValue",
      "geyser",
    ]
    expect(missingFields(present, "building")).toEqual([])
  })
})

describe("summaryValue", () => {
  /* This panel tells the visitor what risk was declared on their behalf, so an
     unticked box must read as the answer "no" — not as "—", which means
     UNANSWERED in every other row of the same table, and not as an empty cell,
     which is what `?? "—"` produced for a box ticked then unticked because ??
     does not fall through an empty string. One answer, three renderings, two
     of them wrong, on a declaration of prior loss. */
  it("renders an unticked checkbox as No, never as a dash or a blank", () => {
    for (const field of ["alarm", "priorBurglary", "geyserCover"] as const) {
      expect(summaryValue(field, undefined, undefined)).toBe("No")
      expect(summaryValue(field, "", undefined)).toBe("No")
    }
  })

  it("renders a ticked checkbox as Yes, never the raw token", () => {
    expect(summaryValue("alarm", "yes", undefined)).toBe("Yes")
  })

  it("renders an amount as money, matching the field's own hint", () => {
    expect(summaryValue("contentsValue", "350000", undefined)).toBe("R 350,000")
    expect(summaryValue("buildingValue", "1200000", undefined)).toBe("R 1,200,000")
  })

  // Their option values are codes — "040" is AUDI — so the label is the only
  // thing that may be shown to a customer.
  it("renders a select as its label, never its value", () => {
    const opts = [{ value: "040", label: "AUDI" }]
    expect(summaryValue("make", "040", opts)).toBe("AUDI")
  })

  it("falls back to the raw answer when the option list has gone", () => {
    expect(summaryValue("make", "040", undefined)).toBe("040")
  })

  it("shows a dash only for a genuinely unanswered non-checkbox", () => {
    expect(summaryValue("make", "", undefined)).toBe("—")
    expect(summaryValue("contentsValue", undefined, undefined)).toBe("—")
  })
})

describe("askedFields", () => {
  it("includes the checkboxes that REQUIRED_FIELDS_BY_VIEW deliberately omits", () => {
    expect(askedFields("home")).toContain("alarm")
    expect(askedFields("home")).toContain("priorBurglary")
    expect(askedFields("building")).toContain("geyserCover")
    expect(REQUIRED_FIELDS_BY_VIEW.home).not.toContain("alarm")
    expect(REQUIRED_FIELDS_BY_VIEW.building).not.toContain("geyserCover")
  })

  it("is a superset of what the view requires", () => {
    for (const view of ["motor", "home", "building"] as const) {
      for (const field of REQUIRED_FIELDS_BY_VIEW[view]) {
        expect(askedFields(view)).toContain(field)
      }
    }
  })

  /* The restore replay walks this list in order and awaits each write, so the
     order is load-bearing on motor: `make`'s options do not exist until
     `vehicleYear` has been written and FSP's AJAX has answered, and `model`'s
     not until `make` has. Replaying them out of order writes into a select
     that does not yet contain the value — write() returns false and the answer
     is dropped SILENTLY, which is how make and model came back empty on every
     "Change answers" round trip once before. Nothing else pins this; a purely
     cosmetic reorder of the "car" step's fields would reintroduce it. */
  it("keeps motor's year → make → model cascade in dependency order", () => {
    const order = askedFields("motor")
    expect(order.indexOf("vehicleYear")).toBeLessThan(order.indexOf("make"))
    expect(order.indexOf("make")).toBeLessThan(order.indexOf("model"))
  })

  it("matches the view's steps in order", () => {
    expect(askedFields("building")).toEqual([
      "birthYear",
      "gender",
      "maritalStatus",
      "suburb",
      "buildingValue",
      "geyserCover",
    ])
  })
})

describe("missingFields — presence is not the same question as requiredness", () => {
  /* The defect this closes: an unticked alarm is a complete ANSWER, so the box
     is not required — but if FSP rename the control, the wizard goes on asking
     "Have you had a burglary at this address?" over something that no longer
     exists. The write fails, the tick snaps back with no message, and because
     isUnanswered reports checkboxes as always answered, Continue stays enabled
     and the quote submits declaring no prior burglary. Gating takeover on the
     ASKED set is what hands the visitor back to FSP's own form instead. */
  const HOME_PRESENT = [
    "DOBYear",
    "Gender",
    "MaritialStatus",
    "SuburbMatch",
    "homecontentsvalue",
    "HomeContentYear",
    "burglary",
    "alarm",
  ]

  it.each(["burglary", "alarm"])(
    "refuses takeover when FSP stop serving %s, even though it is not required",
    (name) => {
      const gaps = missingFields(
        HOME_PRESENT.filter((n) => n !== name),
        "home",
      )
      expect(gaps.length).toBeGreaterThan(0)
    },
  )

  it("refuses takeover when the buildings geyser control is gone", () => {
    const gaps = missingFields(
      ["DOBYear", "Gender", "MaritialStatus", "SuburbMatch", "buildingValue"],
      "building",
    )
    expect(gaps).toEqual(["geyserCover"])
  })

  it("still takes over when every asked control is present", () => {
    expect(missingFields(HOME_PRESENT, "home")).toEqual([])
  })
})

describe("isUnanswered", () => {
  it("treats a blank select as unanswered", () => {
    expect(isUnanswered("make", {})).toBe(true)
    expect(isUnanswered("make", { make: "" })).toBe(true)
    expect(isUnanswered("make", { make: "040" })).toBe(false)
  })

  it("treats a blank number as unanswered", () => {
    expect(isUnanswered("contentsValue", {})).toBe(true)
    expect(isUnanswered("contentsValue", { contentsValue: "350000" })).toBe(false)
  })

  // The point of the rule. An unticked box is the answer "no", and treating it
  // as unanswered would disable Continue until the visitor claimed an alarm
  // they do not have, a burglary that did not happen, or a cover they did not
  // ask for.
  it("never treats a checkbox as unanswered, ticked or not", () => {
    for (const field of ["alarm", "priorBurglary", "geyserCover"] as const) {
      expect(isUnanswered(field, {})).toBe(false)
      expect(isUnanswered(field, { [field]: "" })).toBe(false)
      expect(isUnanswered(field, { [field]: "yes" })).toBe(false)
    }
  })

  it("lets a home journey with nothing ticked reach its last step", () => {
    const answers = {
      birthYear: "1985",
      gender: "1",
      maritalStatus: "1",
      suburb: "SANDTON",
      contentsValue: "350000",
      movedInYear: "2015",
    }
    const steps = WIZARD_STEPS_BY_VIEW.home
    expect(furthestReachableStep(answers, steps)).toBe(steps.length - 1)
  })

  it("still holds a home journey back when the value is missing", () => {
    const answers = { birthYear: "1985", gender: "1", maritalStatus: "1" }
    expect(furthestReachableStep(answers, WIZARD_STEPS_BY_VIEW.home)).toBe(1)
  })
})

describe("acceptsNumber", () => {
  it("takes a value inside FSP's bounds", () => {
    expect(acceptsNumber("contentsValue", "350000")).toBe(true)
    expect(acceptsNumber("buildingValue", "1200000")).toBe(true)
  })

  it("takes the bounds themselves", () => {
    expect(acceptsNumber("contentsValue", "100000")).toBe(true)
    expect(acceptsNumber("contentsValue", "7500000")).toBe(true)
  })

  // The bound is checked here or nowhere: observed on FSP's test site, assigning
  // an out-of-range value to their input succeeds and their model takes it.
  it("refuses a value below or above FSP's bounds", () => {
    expect(acceptsNumber("contentsValue", "99999")).toBe(false)
    expect(acceptsNumber("contentsValue", "7500001")).toBe(false)
    expect(acceptsNumber("buildingValue", "99999")).toBe(false)
    expect(acceptsNumber("buildingValue", "10000001")).toBe(false)
  })

  // Deliberate: `step` is a spinner convenience, not a quotability rule.
  // Refusing R350 500 would be our invention; rounding it would alter a
  // declared sum insured.
  it("takes a value between steps", () => {
    expect(acceptsNumber("contentsValue", "350500")).toBe(true)
  })

  it("refuses anything that is not a plain whole number", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "1e6",
      "-350000",
      "350000.50",
      "350 000",
      "R350000",
      "0x10",
    ]) {
      expect(acceptsNumber("contentsValue", bad)).toBe(false)
    }
  })

  it("refuses a field that is not a number field at all", () => {
    expect(acceptsNumber("make", "350000")).toBe(false)
    expect(acceptsNumber("alarm", "1")).toBe(false)
    expect(acceptsNumber("suburb", "350000")).toBe(false)
  })

  // Mutation guard on the CONSTANTS, not the comparisons: an assertion that
  // reads its bound from the same map it is validating against cannot fail.
  it("pins FSP's measured bounds", () => {
    expect(FIELD_KINDS.contentsValue).toEqual({
      control: "number",
      min: 100000,
      max: 7500000,
      step: 1000,
    })
    expect(FIELD_KINDS.buildingValue).toEqual({
      control: "number",
      min: 100000,
      max: 10000000,
      step: 10000,
    })
  })
})

describe("WIZARD_STEPS", () => {
  it("covers every required field exactly once", () => {
    const inSteps = WIZARD_STEPS.flatMap((s) => s.fields)
    expect([...inSteps].sort()).toEqual([...REQUIRED_FIELDS_BY_VIEW.motor].sort())
    expect(new Set(inSteps).size).toBe(inSteps.length)
  })

  it("gives every step a stable id, title and heading", () => {
    for (const step of WIZARD_STEPS) {
      expect(step.id).toMatch(/^[a-z-]+$/)
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.heading.length).toBeGreaterThan(0)
    }
  })
})

describe("stepProgress", () => {
  it("runs from 0 at the first step to 1 once past the last", () => {
    expect(stepProgress(0)).toBe(0)
    expect(stepProgress(WIZARD_STEPS.length)).toBe(1)
  })

  it("clamps out-of-range indices", () => {
    expect(stepProgress(-3)).toBe(0)
    expect(stepProgress(99)).toBe(1)
  })

  it("increases monotonically", () => {
    const values = WIZARD_STEPS.map((_, i) => stepProgress(i))
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })
})

describe("parsePremium", () => {
  it.each([
    ["R752.96", 752.96],
    ["R1240.72", 1240.72],
    ["R1 234.56", 1234.56],
    ["R1,234.56", 1234.56],
    ["  R838  ", 838],
  ])("parses %o", (input, expected) => {
    expect(parsePremium(input)).toBeCloseTo(expected, 2)
  })

  it.each(["", "n/a", "POA", "—"])("returns 0 for unparseable %o", (input) => {
    expect(parsePremium(input)).toBe(0)
  })
})

describe("summariseQuotes", () => {
  let seq = 0
  const quote = (insurer: string, premium: number) => ({
    index: seq++,
    offeringId: insurer,
    insurer,
    logoUrl: "",
    premium,
    premiumLabel: `R${premium}`,
    excessLabel: "basic excess",
  })

  it("returns null with no quotes", () => {
    expect(summariseQuotes([])).toBeNull()
  })

  it("returns null when no premium parsed", () => {
    expect(summariseQuotes([quote("A", 0), quote("B", 0)])).toBeNull()
  })

  it("computes best, average and the saving against average", () => {
    const s = summariseQuotes([
      quote("Auto & General", 752.96),
      quote("King Price", 829.6),
      quote("Absa", 1240.72),
    ])
    expect(s?.count).toBe(3)
    expect(s?.best).toBeCloseTo(752.96, 2)
    expect(s?.average).toBeCloseTo(941.09, 1)
    expect(s?.savingVsAverage).toBeCloseTo(188.13, 1)
    expect(s?.percentBetter).toBe(20)
  })

  it("never reports a negative saving when every quote is identical", () => {
    const s = summariseQuotes([quote("A", 900), quote("B", 900)])
    expect(s?.savingVsAverage).toBe(0)
    expect(s?.percentBetter).toBe(0)
  })

  it("ignores unparseable premiums rather than dragging the average to zero", () => {
    const s = summariseQuotes([quote("A", 1000), quote("B", 0)])
    expect(s?.average).toBeCloseTo(1000, 2)
    expect(s?.count).toBe(2)
  })
})

describe("sortQuotes", () => {
  let qseq = 0
  const q = (insurer: string, premium: number) => ({
    index: qseq++,
    offeringId: insurer,
    insurer,
    logoUrl: "",
    premium,
    premiumLabel: `R${premium}`,
    excessLabel: "basic excess",
  })

  it("puts the cheapest first", () => {
    const out = sortQuotes([q("A", 900), q("B", 750), q("C", 1200)], "cheapest")
    expect(out.map((x) => x.insurer)).toEqual(["B", "A", "C"])
  })

  it("reverses for dearest", () => {
    const out = sortQuotes([q("A", 900), q("B", 750), q("C", 1200)], "dearest")
    expect(out.map((x) => x.insurer)).toEqual(["C", "A", "B"])
  })

  // An unpriced quote sorting as 0 would present as the best deal in the list.
  it("sinks unpriced quotes to the bottom, not the top", () => {
    const out = sortQuotes([q("priced", 900), q("unpriced", 0)], "cheapest")
    expect(out.map((x) => x.insurer)).toEqual(["priced", "unpriced"])
  })

  it("keeps unpriced quotes last when sorting by dearest too", () => {
    const out = sortQuotes([q("unpriced", 0), q("priced", 900)], "dearest")
    expect(out.map((x) => x.insurer)).toEqual(["priced", "unpriced"])
  })

  it("does not mutate the input", () => {
    const input = [q("A", 900), q("B", 750)]
    sortQuotes(input, "cheapest")
    expect(input.map((x) => x.insurer)).toEqual(["A", "B"])
  })
})

describe("tidyInsurerName", () => {
  it.each([
    ["Virseker Virseker", "Virseker"],
    ["1st For Women 1st For Women", "1st For Women"],
    ["Absa Absa Plus9", "Absa Plus9"],
    ["King Price King Price Comprehensive", "King Price Comprehensive"],
  ])("collapses %o to %o", (input, expected) => {
    expect(tidyInsurerName(input)).toBe(expected)
  })

  // Must not mangle a title that merely shares a word.
  it.each([
    "Auto and General Broker Express",
    "Budget Insurance",
    "MiWay",
    "",
  ])("leaves %o alone", (input) => {
    expect(tidyInsurerName(input)).toBe(input.trim())
  })

  it("collapses the LONGEST repeat, not the first single word", () => {
    // A greedy single-word match would leave "For Women 1st For Women".
    expect(tidyInsurerName("1st For Women 1st For Women")).toBe("1st For Women")
  })

  it("normalises runs of whitespace", () => {
    expect(tidyInsurerName("  Virseker   Virseker  ")).toBe("Virseker")
  })
})

describe("formatRands (house formatter, lib/utils)", () => {
  it.each([
    [184, "R 184.00"],
    [1240, "R 1,240.00"],
    [0, "R 0.00"],
  ])("formats %i as %o", (input, expected) => {
    expect(formatRands(input)).toBe(expected)
  })

  it("drops the cents for whole-rand amounts", () => {
    expect(formatRands(1_200_000, { whole: true })).toBe("R 1,200,000")
    expect(formatRands(184.62, { whole: true })).toBe("R 185")
  })
})

describe("WIZARD_STEPS balance", () => {
  // Load must taper toward the commitment, not peak at it. An earlier split
  // ran 3/2/3/4 with the four hardest questions immediately before submit.
  it("never asks more on the final step than on any earlier one", () => {
    const counts = WIZARD_STEPS.map((s) => s.fields.length)
    const last = counts[counts.length - 1]!
    expect(last).toBeLessThanOrEqual(Math.max(...counts))
    expect(last).toBeLessThanOrEqual(3)
  })

  it("keeps every step within a comfortable range", () => {
    for (const step of WIZARD_STEPS) {
      expect(step.fields.length).toBeGreaterThanOrEqual(2)
      expect(step.fields.length).toBeLessThanOrEqual(3)
    }
  })
})

describe("summariseQuotes — priced vs total", () => {
  const quote = (insurer: string, premium: number) => ({
    index: 0, offeringId: insurer, insurer, logoUrl: "", premium,
    premiumLabel: premium ? `R${premium}` : "", excessLabel: "basic excess",
  })

  // Reporting "4 quotes · average R968" where the average covered 3 is a
  // number that contradicts the count printed beside it.
  it("reports how many quotes the average actually covers", () => {
    const s = summariseQuotes([quote("A", 900), quote("B", 1000), quote("C", 0)])
    expect(s?.count).toBe(3)
    expect(s?.priced).toBe(2)
    expect(s?.average).toBeCloseTo(950, 2)
  })

  it("priced equals count when everything has a premium", () => {
    const s = summariseQuotes([quote("A", 900), quote("B", 1000)])
    expect(s?.priced).toBe(s?.count)
  })
})

describe("waitingStage", () => {
  it("opens on the sending stage", () => {
    expect(waitingStage(0, 0).label).toBe("Sending your details to our panel")
  })

  it("advances on the clock while the copy claims nothing about the panel", () => {
    expect(waitingStage(3000, 0).label).toBe("Insurers are pricing your risk")
    expect(waitingStage(9000, 0).label).toBe("Still going — some insurers take a little longer")
  })

  // The regression this exists for. "the last few insurers" says the rest have
  // already answered; with no rows in, none have. It used to appear at 25s on
  // the clock alone — at the point a run is most likely to be failing.
  it("never claims the last few insurers while no quote has landed", () => {
    for (const elapsed of [25000, 30000, 45000, 120000]) {
      expect(waitingStage(elapsed, 0).label).not.toContain("last few")
    }
  })

  it("holds the honest stage instead of promoting on time alone", () => {
    expect(waitingStage(120000, 0).label).toBe(
      "Still going — some insurers take a little longer",
    )
  })

  it("earns the last-few stage once a row actually lands", () => {
    expect(waitingStage(25000, 1).label).toBe("Still waiting on the last few insurers")
    expect(waitingStage(60000, 4).label).toBe("Still waiting on the last few insurers")
  })

  it("still requires the clock, not just the evidence", () => {
    expect(waitingStage(9000, 5).label).toBe(
      "Still going — some insurers take a little longer",
    )
  })

  it("every stage that names the panel's progress carries an evidence bar", () => {
    for (const stage of WAITING_STAGES) {
      if (/last few|nearly|almost|final/i.test(stage.label)) {
        expect(stage.minQuotes).toBeGreaterThan(0)
      }
    }
  })
})

describe("furthestReachableStep", () => {
  const you = { birthYear: "1989", gender: "1", maritalStatus: "1" }
  const where = { suburb: "SANDTON (2196)", overnightParking: "1", vehicleUse: "10" }
  const car = { vehicleYear: "2022", make: "600", model: "60027910" }
  const licence = { licenceType: "4", licenceYear: "2010", lastClaim: "8" }

  it("pins an empty journey to the first step", () => {
    expect(furthestReachableStep({}, WIZARD_STEPS)).toBe(0)
  })

  it("opens each step only once the one before it is answered", () => {
    expect(furthestReachableStep(you, WIZARD_STEPS)).toBe(1)
    expect(furthestReachableStep({ ...you, ...where }, WIZARD_STEPS)).toBe(2)
    expect(furthestReachableStep({ ...you, ...where, ...car }, WIZARD_STEPS)).toBe(3)
  })

  it("allows the last step when everything is answered", () => {
    expect(
      furthestReachableStep({ ...you, ...where, ...car, ...licence }, WIZARD_STEPS),
    ).toBe(WIZARD_STEPS.length - 1)
  })

  // The regression this exists for. After "Change answers" the suburb is
  // deliberately dropped, but the stale history entries still say step 2 and 3.
  // Trusting them skipped the step holding the suburb, and the quote that
  // followed came back empty and blamed the insurers.
  it("holds a restored journey at the gate when the suburb was dropped", () => {
    const restored = { ...you, ...where, ...car, ...licence, suburb: "" }
    expect(furthestReachableStep(restored, WIZARD_STEPS)).toBe(1)
  })

  it("clamps a stale forward index rather than honouring it", () => {
    const restored = { ...you, ...where, ...car, ...licence, suburb: "" }
    for (const stale of [2, 3, 99]) {
      expect(Math.min(stale, furthestReachableStep(restored, WIZARD_STEPS))).toBe(1)
    }
  })

  it("never returns a step that does not exist", () => {
    const idx = furthestReachableStep({ ...you, ...where, ...car, ...licence }, WIZARD_STEPS)
    expect(idx).toBeLessThan(WIZARD_STEPS.length)
    expect(WIZARD_STEPS[idx]).toBeDefined()
  })
})

describe("settleDelay", () => {
  const T = { paint: 400, signalSilent: 12000, blind: 4500 }

  it("waits only for a paint once their signal has fired", () => {
    expect(settleDelay(true, true, T)).toBe(400)
  })

  // The regression this exists for. Revealing on the blind debounce while
  // their signal still read false badged R897.71 as best with the real
  // cheapest, R729.60, still arriving.
  it("does NOT fall back to the blind debounce while a signal is pending", () => {
    expect(settleDelay(false, true, T)).not.toBe(4500)
    expect(settleDelay(false, true, T)).toBe(12000)
  })

  it("uses the blind debounce only when there is no signal to wait for", () => {
    expect(settleDelay(false, false, T)).toBe(4500)
  })

  it("a fired signal wins over everything — it is the strongest evidence", () => {
    expect(settleDelay(true, false, T)).toBe(400)
  })

  it("never waits longer once the panel is confirmed than while it is not", () => {
    expect(settleDelay(true, true, T)).toBeLessThan(settleDelay(false, true, T))
    expect(settleDelay(true, false, T)).toBeLessThan(settleDelay(false, false, T))
  })
})

describe("arrivalPlan", () => {
  let seq = 0
  const q = (insurer: string, premium: number) => ({
    index: seq++,
    offeringId: insurer,
    insurer,
    logoUrl: "",
    premium,
    premiumLabel: `R${premium}`,
    excessLabel: "basic excess",
  })

  // FSP's real return order as observed on their test site, which is not
  // price order — that mismatch is the whole point of the re-sort.
  const arrived = () => [
    q("King Price", 729.6),
    q("Absa Plus9", 1095.16),
    q("Auto and General", 666.44),
    q("Virseker", 748.54),
    q("1st For Women", 831.85),
  ]

  it("holds every row in arrival order while the panel is still answering", () => {
    const plan = arrivalPlan(arrived(), false)
    expect(plan.map((s) => s.settlesAt)).toEqual([0, 1, 2, 3, 4])
    expect(plan.map((s) => s.arrivedAt)).toEqual([0, 1, 2, 3, 4])
  })

  it("re-sorts to price order once the panel completes", () => {
    const plan = arrivalPlan(arrived(), true)
    // Auto and General (666.44) is cheapest, so it settles at the top.
    const bySettled = [...plan].sort((a, b) => a.settlesAt - b.settlesAt)
    expect(bySettled.map((s) => s.quote.insurer)).toEqual([
      "Auto and General",
      "King Price",
      "Virseker",
      "1st For Women",
      "Absa Plus9",
    ])
  })

  it("keeps arrivedAt as FSP's order even after the re-sort", () => {
    // The component animates FROM arrivedAt TO settlesAt; if the re-sort
    // rewrote arrivedAt there would be nothing to animate from.
    const plan = arrivalPlan(arrived(), true)
    expect(plan.map((s) => s.quote.insurer)).toEqual([
      "King Price",
      "Absa Plus9",
      "Auto and General",
      "Virseker",
      "1st For Women",
    ])
    expect(plan.map((s) => s.arrivedAt)).toEqual([0, 1, 2, 3, 4])
  })

  it("badges NOTHING as best while the panel is still answering", () => {
    // The documented failure: R897.71 wore "Best price" with the real
    // cheapest still in flight. Cheapest-so-far is not cheapest.
    const plan = arrivalPlan(arrived(), false)
    expect(plan.some((s) => s.isBest)).toBe(false)
  })

  it("badges exactly one row as best once the panel completes", () => {
    const plan = arrivalPlan(arrived(), true)
    expect(plan.filter((s) => s.isBest)).toHaveLength(1)
    expect(plan.find((s) => s.isBest)?.quote.insurer).toBe("Auto and General")
  })

  it("never badges an unpriced row as best, even if it arrived first", () => {
    const plan = arrivalPlan([q("Unpriced", 0), q("Priced", 900)], true)
    expect(plan.find((s) => s.isBest)?.quote.insurer).toBe("Priced")
  })

  it("sinks unpriced rows to the bottom on settle", () => {
    const plan = arrivalPlan([q("Unpriced", 0), q("Dear", 1200), q("Cheap", 500)], true)
    const bySettled = [...plan].sort((a, b) => a.settlesAt - b.settlesAt)
    expect(bySettled.map((s) => s.quote.insurer)).toEqual(["Cheap", "Dear", "Unpriced"])
  })

  it("has no best row at all when nothing carries a premium", () => {
    const plan = arrivalPlan([q("A", 0), q("B", 0)], true)
    expect(plan.some((s) => s.isBest)).toBe(false)
  })

  it("returns an empty plan for no quotes", () => {
    expect(arrivalPlan([], true)).toEqual([])
  })

  it("keys position off row index, not insurer name, when names collide", () => {
    // Two offerings from the same insurer is normal on this panel; a
    // name-keyed map would collapse them onto one slot.
    const plan = arrivalPlan([q("Same", 900), q("Same", 700)], true)
    expect([...plan].sort((a, b) => a.settlesAt - b.settlesAt).map((s) => s.quote.premium)).toEqual([
      700, 900,
    ])
    expect(new Set(plan.map((s) => s.settlesAt)).size).toBe(2)
  })
})

describe("shouldHoldForResort", () => {
  it("holds once the panel is complete and there is something to reorder", () => {
    expect(shouldHoldForResort(true, 5, false)).toBe(true)
  })

  it("releases after the re-sort has played", () => {
    expect(shouldHoldForResort(true, 5, true)).toBe(false)
  })

  // The hold must never wait on a signal that may not arrive. If FSP never
  // confirm the panel, the journey proceeds exactly as it did before.
  it("never holds while the panel is still answering", () => {
    expect(shouldHoldForResort(false, 5, false)).toBe(false)
    expect(shouldHoldForResort(false, 0, false)).toBe(false)
  })

  it("does not hold for a single row, which cannot reorder", () => {
    expect(shouldHoldForResort(true, 1, false)).toBe(false)
    expect(shouldHoldForResort(true, 0, false)).toBe(false)
  })

  it("holds for the smallest set that can actually reorder", () => {
    expect(shouldHoldForResort(true, 2, false)).toBe(true)
  })
})

describe("FIELD_NAMES — what actually reaches FSP", () => {
  // The quote page and the ID shortcut both tell the visitor, in as many
  // words, that their identity number "is not sent with your quote". That is
  // true only while no ID field exists in this map: set() accepts a
  // QuickQuoteField, so the map IS the list of everything that can be written
  // into FSP's form. Adding an ID key here would silently make two pieces of
  // user-facing copy false, which is exactly the kind of claim this repo
  // treats as a factual statement rather than marketing.
  it("carries no identity-number field", () => {
    const keys = Object.keys(FIELD_NAMES)
    const idish = keys.filter((k) => /^(sa)?id(number)?$/i.test(k))
    expect(idish).toEqual([])
  })

  it("maps nothing onto an FSP field that looks like an ID number", () => {
    // Their side, not ours — a rename on their form could introduce one.
    // DriversLicenceTypeId is a licence CODE, not an identity number.
    const targets = Object.values(FIELD_NAMES)
    expect(targets.filter((t) => /idnumber|identity/i.test(t))).toEqual([])
  })
})

describe("canAddVehicle", () => {
  const complete: Partial<Record<QuickQuoteField, string>> = {
    vehicleYear: "2018",
    make: "040",
    model: "04025040",
    vehicleUse: "10",
    overnightParking: "1",
    lastClaim: "8",
    licenceYear: "2005",
    licenceType: "4",
  }

  it("allows the add once every field FSP validates is answered", () => {
    expect(canAddVehicle(complete)).toBe(true)
  })

  // The whole reason this function exists. FSP's saveVehicle runs
  // `if (!valid) return;` — so a tick with any of these blank does NOTHING,
  // with no error anywhere. One case per CURRENT entry in the constant.
  //
  // This is coverage of the function's LOGIC, not of ADD_VEHICLE_GATE_FIELDS's
  // membership: `it.each` reads the constant at collection time, so deleting a
  // field from it just shrinks the loop to match — 7 cases instead of 8, all
  // still green, gate silently widened, nothing here fails. What these DO
  // catch is `.every` regressing to `.some` (or any other change to how a
  // blank is detected): every remaining field has to independently prove it
  // still blocks the add. The test that actually fails on a narrowed
  // constant is the hardcoded-literal one below — mutate the CONSTANT there,
  // not here.
  it.each(ADD_VEHICLE_GATE_FIELDS)("refuses the add when %s is unanswered", (field) => {
    expect(canAddVehicle({ ...complete, [field]: "" })).toBe(false)
  })

  it.each(ADD_VEHICLE_GATE_FIELDS)("refuses the add when %s is absent entirely", (field) => {
    const missing = { ...complete }
    delete missing[field]
    expect(canAddVehicle(missing)).toBe(false)
  })

  // Their validator only walks `#tVehicles select`. The policyholder questions
  // live outside it, so requiring them here would refuse an add FSP would have
  // accepted — a gate stricter than the thing it guards is still a bug.
  it("does not require the policyholder questions", () => {
    expect(canAddVehicle({ ...complete, birthYear: "", gender: "", suburb: "" })).toBe(true)
  })

  // LOAD-BEARING — do not delete as apparently redundant with the two
  // `it.each(ADD_VEHICLE_GATE_FIELDS)` blocks above. It looks like the same
  // ground covered twice, but it is the opposite kind of check: this compares
  // against a hardcoded literal, so it is the ONLY test in the file that
  // fails if a field is ever removed from ADD_VEHICLE_GATE_FIELDS. The
  // `it.each` blocks iterate the constant itself and cannot see a narrowing —
  // see the comment above them.
  it("gates exactly the eight controls inside #tVehicles", () => {
    expect([...ADD_VEHICLE_GATE_FIELDS].sort()).toEqual(
      [
        "lastClaim",
        "licenceType",
        "licenceYear",
        "make",
        "model",
        "overnightParking",
        "vehicleUse",
        "vehicleYear",
      ].sort(),
    )
  })
})

describe("the vehicle / policy field split", () => {
  // Observed after addVehicle(): #tVehicles held exactly Year, Make, Model,
  // vehicleuse, overnightparking. Everything else was gone from the DOM.
  it("asks five fields per additional vehicle", () => {
    expect([...VEHICLE_FIELDS].sort()).toEqual(
      ["make", "model", "overnightParking", "vehicleUse", "vehicleYear"].sort(),
    )
  })

  // A field that is in neither list is never asked; a field in both is asked
  // twice and the second write overwrites the first vehicle's answer.
  it("partitions the required fields exactly once each", () => {
    expect([...POLICY_FIELDS, ...VEHICLE_FIELDS].sort()).toEqual([...REQUIRED_FIELDS_BY_VIEW.motor].sort())
  })

  it("keeps the two lists disjoint", () => {
    const overlap = VEHICLE_FIELDS.filter((f) => POLICY_FIELDS.includes(f))
    expect(overlap).toEqual([])
  })
})

describe("buildSteps", () => {
  it("is today's four steps for a single car", () => {
    expect(buildSteps(1)).toEqual(WIZARD_STEPS)
    // toEqual alone would still pass for a content-equal COPY. The docstring
    // promises the SAME array reference — a future refactor that started
    // building a new array here would break that promise with nothing above
    // catching it, so the identity itself has to be asserted.
    expect(buildSteps(1)).toBe(WIZARD_STEPS)
  })

  it("adds one step per additional car", () => {
    expect(buildSteps(2)).toHaveLength(WIZARD_STEPS.length + 1)
    expect(buildSteps(3)).toHaveLength(WIZARD_STEPS.length + 2)
  })

  it("asks only the per-vehicle fields on an added car", () => {
    expect(buildSteps(2).at(-1)?.fields).toEqual(VEHICLE_FIELDS)
  })

  it("caps at MAX_VEHICLES", () => {
    expect(buildSteps(99)).toEqual(buildSteps(MAX_VEHICLES))
  })

  it.each([0, -1, Number.NaN])("treats %s as one car rather than throwing", (n) => {
    expect(buildSteps(n)).toEqual(WIZARD_STEPS)
  })

  // Copy is a factual claim. "Last thing — your licence" is true on a one-car
  // journey and false the moment a second car is appended after it, and the
  // step that says it is the one the visitor reads immediately before ticking
  // "I have more cars".
  it("only claims finality on the step that is actually last", () => {
    expect(buildSteps(1).at(-1)?.heading).toContain("Last thing")
    const driving = buildSteps(2).find((s) => s.id === "driving")
    expect(driving?.heading).not.toContain("Last thing")
  })

  // MAX_VEHICLES is the only case with a non-final EXTRA step ("Now car 2") in
  // play alongside the final one ("Last thing — car 3") — exactly the
  // configuration a regression in the `n === cars` check would hit first, and
  // the two-car case above cannot exercise it.
  it("only claims finality on the step that is actually last, at MAX_VEHICLES", () => {
    const steps = buildSteps(3)
    expect(steps.find((s) => s.id === "driving")?.heading).not.toContain("Last thing")
    expect(steps.find((s) => s.id === "car-2")?.heading).not.toContain("Last thing")
    expect(steps.find((s) => s.id === "car-3")?.heading).toContain("Last thing")
  })

  it("gives every step a unique id", () => {
    const ids = buildSteps(MAX_VEHICLES).map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/**
 * The second argument splits two quantities that used to be one.
 *
 * `vehicleCount` means "cars FSP hold" — it caps the journey at MAX_VEHICLES
 * and decides whether the results summary is a multi-car one. The appended
 * step count means "car steps we still owe the visitor", which is a different
 * number the moment a "Change answers" restore puts several cars back into
 * FSP's model without the visitor adding any of them in this session.
 *
 * They were equal while cars could only arrive one add at a time, and a
 * restore broke that: it manufactured appended steps with no add behind them,
 * every one of them editing FSP's ACTIVE (last) vehicle because their fields
 * are flat and un-indexed. Four steps, identically prefilled, and an edit on
 * the one titled "Your car" silently rewriting car 3.
 */
describe("buildSteps — cars held vs car steps owed", () => {
  it("defaults to one appended step per additional car, so every existing call is unchanged", () => {
    expect(buildSteps(2)).toEqual(buildSteps(2, 1))
    expect(buildSteps(3)).toEqual(buildSteps(3, 2))
    expect(buildSteps(1)).toEqual(buildSteps(1, 0))
  })

  // The restored journey: FSP hold three cars, we owe no car steps, so the
  // visitor gets today's four steps editing the active car. savedVehicles
  // still carries the earlier two into the summary.
  it("owes no car steps after a restore, however many cars FSP hold", () => {
    expect(buildSteps(2, 0)).toEqual(WIZARD_STEPS)
    expect(buildSteps(3, 0)).toEqual(WIZARD_STEPS)
    expect(buildSteps(3, 0)).toHaveLength(WIZARD_STEPS.length)
  })

  /**
   * THE point of the split, and the one that cannot be got right by accident.
   *
   * A restore that landed two cars, followed by the visitor adding a third,
   * owes exactly ONE step — and that step is car 3, not car 2. Index and car
   * number are no longer the same number, so a label derived from position in
   * the array reads "Car 2" here and asks the visitor to describe a car FSP
   * are not holding open for editing.
   */
  it("labels the appended step by the CAR it edits, not by its position", () => {
    const steps = buildSteps(3, 1)
    expect(steps).toHaveLength(WIZARD_STEPS.length + 1)
    // Position 4 is the FIRST appended step; an index-derived label would say
    // "Car 2" here. Both halves are asserted because the sidebar shows the
    // title and the panel shows the heading.
    expect(steps.at(-1)?.title).toBe("Car 3")
    expect(steps.at(-1)?.heading).toContain("car 3")
    expect(steps.at(-1)?.id).toBe("car-3")
    expect(steps.map((s) => s.title)).not.toContain("Car 2")
  })

  it("still asks only the per-vehicle fields on an appended step", () => {
    expect(buildSteps(3, 1).at(-1)?.fields).toEqual(VEHICLE_FIELDS)
  })

  // The finality rule has to survive the new shape: with no appended step the
  // licence step IS last and must say so, and with one appended step it is not
  // and must not.
  it("keeps no step claiming to be last unless it is, across the split", () => {
    const restored = buildSteps(3, 0)
    expect(restored.find((s) => s.id === "driving")?.heading).toContain("Last thing")

    const oneOwed = buildSteps(3, 1)
    expect(oneOwed.find((s) => s.id === "driving")?.heading).not.toContain("Last thing")
    expect(oneOwed.find((s) => s.id === "car-3")?.heading).toContain("Last thing")
  })

  it("gives every step a unique id under the split", () => {
    const ids = buildSteps(3, 1).map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Owing more steps than there are cars behind them would append a step for a
  // car FSP do not hold — the mirror of the defect this argument exists to fix.
  it("cannot owe more car steps than there are additional cars", () => {
    expect(buildSteps(2, 9)).toEqual(buildSteps(2, 1))
    expect(buildSteps(1, 9)).toEqual(WIZARD_STEPS)
  })

  it.each([-1, Number.NaN])("treats %s owed steps as none rather than throwing", (n) => {
    expect(buildSteps(3, n)).toEqual(WIZARD_STEPS)
  })
})

describe("furthestReachableStep with added vehicles", () => {
  const carOne: Partial<Record<QuickQuoteField, string>> = {
    birthYear: "1985",
    gender: "1",
    maritalStatus: "1",
    suburb: "SANDTON (2196)",
    overnightParking: "1",
    vehicleUse: "10",
    vehicleYear: "2018",
    make: "040",
    model: "04025040",
    licenceType: "4",
    licenceYear: "2005",
    lastClaim: "8",
  }

  /**
   * The state this describes is "car 1 committed, car 2 not started" — which
   * is the state an add actually leaves behind, because the add clears
   * VEHICLE_FIELDS from answers so car 2's selects do not display car 1's
   * model over an empty FSP form.
   *
   * The number is 1, the "where" step, and that is the Task 5 Critical
   * written down: two of the five per-vehicle fields — overnightParking and
   * vehicleUse — live on the "where" step, not on the car step, so clearing
   * them reopens a step BEHIND the one the visitor is on. Encoding it here is
   * what stops a Back that lands two steps short from coming back.
   *
   * The previous version of this test passed `carOne` with all twelve fields
   * answered, so `findIndex` returned -1 and the assertion landed on the
   * `steps.length - 1` fallback — it would have passed against an
   * implementation that always returned the last index, and said nothing at
   * all about added vehicles.
   */
  it("clamps to the where step once an add has cleared the vehicle answers", () => {
    const afterAdd: Partial<Record<QuickQuoteField, string>> = { ...carOne }
    for (const f of VEHICLE_FIELDS) delete afterAdd[f]

    const steps = buildSteps(2)
    expect(furthestReachableStep(afterAdd, steps)).toBe(1)
    // Named, not just numbered: the number only means something while step 1
    // is the step holding the two vehicle fields, and a reorder of
    // WIZARD_STEPS must fail here rather than quietly change what is asserted.
    expect(steps[1].id).toBe("where")
  })

  // The complement, so the clamp is pinned from both sides: with every field
  // answered the visitor really is entitled to the last step.
  it("allows the second-car step once every answer is in", () => {
    const steps = buildSteps(2)
    expect(furthestReachableStep(carOne, steps)).toBe(steps.length - 1)
    expect(steps.at(-1)?.id).toBe("car-2")
  })

  it("still clamps to the first gap on a single-car journey", () => {
    expect(furthestReachableStep({ birthYear: "1985" }, WIZARD_STEPS)).toBe(0)
  })
})

describe("amountRangeHint", () => {
  // Fair Score audit row 117: a typed whole-rand amount carries no cents.
  it("states the bounds in whole rands, house format", () => {
    expect(amountRangeHint("contentsValue")).toBe("Between R 100,000 and R 7,500,000")
  })
})
