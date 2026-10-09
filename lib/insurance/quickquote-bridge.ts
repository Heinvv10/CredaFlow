/**
 * The bridge between our wizard UI and FSP's QuickQuote form.
 *
 * FSP give us a rendered form, not an API — so to own the journey we render
 * our own stepped wizard and drive their form underneath it. Their `#fspqq`
 * form stays in the page, hidden, and remains the authority: we write our
 * answers into its fields, let their own AJAX populate the cascading lookups,
 * read the options back out, and finally submit it. Proven to work: the same
 * value+dispatchEvent technique returns live quotes.
 *
 * Everything here is pure so it can be tested without a browser. The DOM work
 * lives in components/insurance/QuickQuoteWizard.tsx.
 *
 * ## The coupling, stated plainly
 *
 * This depends on FSP's field NAMES. Their integration guide says "any new
 * products or features added by us will automatically update to your site",
 * so those names can change without notice. Field names are far more stable
 * than layout, but the wizard must still degrade rather than break: if a
 * required field is missing, reveal their own form instead of trapping the
 * visitor behind ours. See FIELD_NAMES and `missingFields`.
 */

import type { QuickQuoteView } from "./quickquote-config"

/** Their form controls, by `name` (or `id` where they use one). */
export const FIELD_NAMES = {
  birthYear: "DOBYear",
  gender: "Gender",
  maritalStatus: "MaritialStatus", // sic — their spelling
  suburb: "SuburbMatch",
  vehicleYear: "Year",
  make: "Make",
  model: "Model",
  vehicleUse: "vehicleuse",
  overnightParking: "overnightparking",
  lastClaim: "LastClaim",
  licenceYear: "DriversLicenceObtainedYear",
  licenceType: "DriversLicenceTypeId",
  // Home contents. MEASURED on quote-staging 2026-08-09.
  contentsValue: "homecontentsvalue",
  // Their name says "content year"; their LABEL and their binding both say
  // otherwise — "When did you move into this home?", binding $data.MovedInYear.
  // Named for what it asks, so nobody re-derives it from their name.
  movedInYear: "HomeContentYear",
  // NOT burglar bars. FSP's own label is "Yes, I have suffered a burglary at
  // this address" — a prior-loss question. Named so the distinction survives.
  priorBurglary: "burglary",
  alarm: "alarm",
  // Buildings.
  buildingValue: "buildingValue",
  // A cover ELECTION, not a risk fact: "Yes, please include geyser cover".
  geyserCover: "geyser",
} as const

export type QuickQuoteField = keyof typeof FIELD_NAMES

/**
 * How each field is asked, and what a valid answer is.
 *
 * Declared rather than inferred. The wizard used to reason "everything is a
 * select except the suburb", which was true while the journey was motor-only
 * and silently wrong the moment a number or a checkbox appeared: `write()`
 * verifies a select by re-reading `el.value`, and a checkbox reports "on"
 * regardless of whether it is ticked.
 *
 * `min`/`max` are FSP's, measured from the rendered `attr:` binding. They are
 * BROWSER-VALIDATION attributes only: assigning an out-of-range value succeeds
 * and their knockout model takes it. So the bound has to be checked here,
 * before the write, or it is not checked at all.
 */
export type FieldKind =
  | { control: "select" }
  | { control: "suburb" }
  | { control: "checkbox" }
  | { control: "number"; min: number; max: number; step: number }

export const FIELD_KINDS: Record<QuickQuoteField, FieldKind> = {
  birthYear: { control: "select" },
  gender: { control: "select" },
  maritalStatus: { control: "select" },
  suburb: { control: "suburb" },
  vehicleYear: { control: "select" },
  make: { control: "select" },
  model: { control: "select" },
  vehicleUse: { control: "select" },
  overnightParking: { control: "select" },
  lastClaim: { control: "select" },
  licenceYear: { control: "select" },
  licenceType: { control: "select" },
  contentsValue: { control: "number", min: 100_000, max: 7_500_000, step: 1_000 },
  movedInYear: { control: "select" },
  priorBurglary: { control: "checkbox" },
  alarm: { control: "checkbox" },
  buildingValue: { control: "number", min: 100_000, max: 10_000_000, step: 10_000 },
  geyserCover: { control: "checkbox" },
}

/**
 * Whether `value` is one FSP can actually quote for this field.
 *
 * Their `min`/`max` reach the DOM as validation attributes, which assignment
 * does not consult — measured on quote-staging: writing 50 into a field whose
 * min is 100 000 succeeds, and their knockout model takes it. So this is the
 * only place the bound is enforced.
 *
 * Refuses rather than clamps. The value is a declared sum insured; quietly
 * moving it to the nearest bound would put a number on an insurance
 * application that the visitor never gave.
 *
 * `step` is deliberately NOT enforced. It is a spinner convenience, not a
 * quotability rule: refusing R350 500 as a contents value would be our
 * invention rather than FSP's.
 */
export function acceptsNumber(field: QuickQuoteField, value: string): boolean {
  const kind = FIELD_KINDS[field]
  if (kind.control !== "number") return false
  // Plain digits only. Number() would take "1e6", " 12 " and "0x10".
  if (!/^\d+$/.test(value)) return false
  const n = Number(value)
  return n >= kind.min && n <= kind.max
}

/**
 * Whether a field is still waiting for an answer.
 *
 * A checkbox NEVER is: unticked is the answer "no". The wizard stores that as
 * an empty string, and every completeness test in the component read empty as
 * unanswered — which would have left Continue disabled until the visitor
 * ticked the box. On these three questions that means claiming an alarm they
 * do not have, a burglary that did not happen, or a cover they did not ask
 * for, purely to get past the step. Two of those are material misstatements
 * on an insurance application.
 *
 * Lives here rather than inline in the component because it is the rule that
 * decides whether a visitor can proceed truthfully, and a node-environment
 * suite cannot render the component to check it.
 */
export function isUnanswered(
  field: QuickQuoteField,
  answers: Partial<Record<QuickQuoteField, string>>,
): boolean {
  if (FIELD_KINDS[field].control === "checkbox") return false
  return (answers[field] ?? "") === ""
}

/**
 * Fields without which the quote cannot be submitted, per view.
 *
 * Per-view because the views do not share a form: neither home nor buildings
 * has any licence or LastClaim control, so a single global list would report
 * eight phantom gaps on a home form and hand every home visitor back to FSP's
 * own UI.
 *
 * Checkboxes are deliberately absent from every list. Unticked is an ANSWER —
 * see FIELD_KINDS — and a required-gate on one would make the visitor claim a
 * security feature, or a burglary, to get past the step.
 */
export const REQUIRED_FIELDS_BY_VIEW: Record<
  QuickQuoteView,
  readonly QuickQuoteField[]
> = {
  motor: [
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
  ],
  home: [
    "birthYear",
    "gender",
    "maritalStatus",
    "suburb",
    "contentsValue",
    "movedInYear",
  ],
  building: ["birthYear", "gender", "maritalStatus", "suburb", "buildingValue"],
}

/**
 * Which of the fields this view ASKS are absent from the form FSP served.
 *
 * The caller uses a non-empty result to fall back to FSP's own UI rather than
 * present a wizard that cannot complete.
 *
 * ## Asked, not required — these are two different questions
 *
 * It walks `askedFields`, not `REQUIRED_FIELDS_BY_VIEW`. Being optional to
 * ANSWER and being optional to be PRESENT are separate properties, and
 * collapsing them into one list broke the fallback for the three checkboxes:
 * an unticked alarm is a complete answer, so the box is not required — but if
 * FSP rename `burglary`, `missingFields` saw nothing wrong, takeover
 * succeeded, and the wizard went on asking "Have you had a burglary at this
 * address?" over a control that no longer exists. `write()` returned false,
 * the tick snapped back with no message, and `isUnanswered` reports checkboxes
 * as always answered, so Continue stayed enabled and the quote submitted
 * declaring no prior burglary. A risk declaration the visitor actually made,
 * discarded silently, on a live insurance application.
 *
 * `view` is required rather than defaulted: the three views serve genuinely
 * different forms, and a default would have every home visitor measured
 * against motor's twelve fields and handed straight back to FSP.
 */
export function missingFields(
  present: readonly string[],
  view: QuickQuoteView,
): QuickQuoteField[] {
  const have = new Set(present)
  return askedFields(view).filter((f) => !have.has(FIELD_NAMES[f]))
}

/**
 * The controls FSP's own `saveVehicle` validates before it will add a car.
 *
 * MEASURED, not inferred (quote-staging, 2026-08-08): `#tVehicles` is
 * `data-bind="with: $root.activeVehicle"` and `saveVehicle` iterates EVERY
 * select inside it, then `if (!valid) return;`. So a tick with any of these
 * unanswered does nothing whatsoever — no error, no message, no state change.
 * A checkbox that silently ignores you is worse than one that is not there.
 *
 * Deliberately NOT the same list as VEHICLE_FIELDS. Three of these —
 * `lastClaim`, `licenceYear`, `licenceType` — are per-POLICY and disappear
 * from the DOM after the first add, but they are inside `#tVehicles` for the
 * FIRST car and therefore inside what their validator walks.
 */
export const ADD_VEHICLE_GATE_FIELDS: readonly QuickQuoteField[] = [
  "vehicleYear",
  "make",
  "model",
  "vehicleUse",
  "overnightParking",
  "lastClaim",
  "licenceYear",
  "licenceType",
]

/**
 * Whether ticking FSP's "more cars" control would actually do anything.
 *
 * The control is only offered when this is true. Offering it otherwise
 * produces a checkbox that ticks and does nothing, which reads as a broken
 * page rather than an unmet precondition.
 */
export function canAddVehicle(
  answers: Partial<Record<QuickQuoteField, string>>,
): boolean {
  return ADD_VEHICLE_GATE_FIELDS.every((f) => (answers[f] ?? "") !== "")
}

// ---------------------------------------------------------------------------
// SA identity number
// ---------------------------------------------------------------------------

export type IdDetails = {
  /** Four-digit year of birth. */
  birthYear: number
  /** FSP's Gender option text. */
  gender: "Male" | "Female"
}

/**
 * Luhn check digit, as used by the SA identity number's 13th digit.
 */
function luhnValid(id: string): boolean {
  let sum = 0
  let alternate = false
  for (let i = id.length - 1; i >= 0; i--) {
    let digit = Number(id[i])
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return sum % 10 === 0
}

/**
 * Derives year of birth and gender from a South African identity number.
 *
 * Saves the visitor two questions — the same trick Hippo use ("Your ID number
 * allows us to save you time"). Returns null for anything that is not a valid
 * SA ID, so the wizard can fall back to asking directly rather than acting on
 * a bad parse.
 *
 * Layout: YYMMDD (6) · SSSS (4, gender: >=5000 male) · C (1) · A (1) · Z (1).
 *
 * @param referenceYear four-digit year used to resolve the century, so the
 *   result does not silently change meaning as time passes.
 */
export function detailsFromSaIdNumber(
  idNumber: string,
  referenceYear: number,
): IdDetails | null {
  const digits = idNumber.replace(/\s/g, "")
  if (!/^\d{13}$/.test(digits)) return null
  if (!luhnValid(digits)) return null

  const month = Number(digits.slice(2, 4))
  const day = Number(digits.slice(4, 6))
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null

  // Two-digit year: assume the most recent past century that yields a
  // plausible birth year. A "26" in 2026 means 1926, not a newborn — nobody
  // insures a car on the day they are born.
  const yy = Number(digits.slice(0, 2))
  const currentCentury = Math.floor(referenceYear / 100) * 100
  let birthYear = currentCentury + yy
  if (birthYear > referenceYear - 16) birthYear -= 100

  const genderSequence = Number(digits.slice(6, 10))
  return {
    birthYear,
    gender: genderSequence >= 5000 ? "Male" : "Female",
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type WizardStep = {
  id: string
  /** Sidebar label. */
  title: string
  /** Question shown as the step heading. */
  heading: string
  fields: readonly QuickQuoteField[]
}

/**
 * The journey.
 *
 * Grouped rather than one-question-per-screen: twelve single-question screens
 * would feel longer, not faster. Fields are grouped by what the visitor is
 * thinking about — themselves, then where the car lives, then the car, then
 * their licence.
 *
 * Three questions per step, evenly. An earlier split ran 3/2/3/4 and put the
 * four hardest questions immediately before the submit — load should taper
 * toward the commitment, not peak at it.
 */
/**
 * The visitor-facing name for each question.
 *
 * Lives here, not in the wizard, because two surfaces render it: the wizard
 * itself and the boot skeleton that reserves the wizard's space while FSP's
 * widget loads. A second copy would drift, and the drift would be invisible —
 * the skeleton would simply stop matching the form it is standing in for.
 */
export const LABELS: Record<QuickQuoteField, string> = {
  birthYear: "Year of birth",
  gender: "Gender",
  maritalStatus: "Marital status",
  suburb: "Suburb",
  vehicleYear: "Year of manufacture",
  make: "Make",
  model: "Model",
  vehicleUse: "What do you use it for?",
  overnightParking: "Where is it parked overnight?",
  lastClaim: "When did you last claim?",
  licenceYear: "Year you got your licence",
  licenceType: "Licence code",
  contentsValue: "What are your home contents worth?",
  movedInYear: "When did you move into this home?",
  alarm: "Do you have an alarm in working order?",
  priorBurglary: "Have you had a burglary at this address?",
  buildingValue: "What is the building worth?",
  geyserCover: "Include geyser cover?",
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: "you",
    title: "About you",
    heading: "Let's start with you",
    fields: ["birthYear", "gender", "maritalStatus"],
  },
  {
    id: "where",
    title: "Where it lives",
    heading: "Where the car lives, and what it's for",
    fields: ["suburb", "overnightParking", "vehicleUse"],
  },
  {
    id: "car",
    title: "Your car",
    heading: "Tell us about the car",
    fields: ["vehicleYear", "make", "model"],
  },
  {
    id: "driving",
    title: "Your driving",
    heading: "Last thing — your licence",
    fields: ["licenceType", "licenceYear", "lastClaim"],
  },
]

/**
 * The journey per view.
 *
 * `motor` is WIZARD_STEPS ITSELF, not a copy — `buildSteps` returns that same
 * identity for a one-car journey, and the flag-off regression floor is
 * asserted on it with `toBe`.
 *
 * The home journey's last step is titled for BOTH kinds of question it holds.
 * `alarm` is a security feature and `priorBurglary` is claims history, so
 * calling the step "Security" would have mislabelled half of it — and on an
 * insurance application the label is part of the question.
 */
export const WIZARD_STEPS_BY_VIEW: Record<QuickQuoteView, readonly WizardStep[]> = {
  motor: WIZARD_STEPS,
  home: [
    {
      id: "you",
      title: "About you",
      heading: "Let's start with you",
      fields: ["birthYear", "gender", "maritalStatus"],
    },
    {
      id: "home",
      title: "Your home",
      heading: "About the home and what's in it",
      fields: ["suburb", "contentsValue", "movedInYear"],
    },
    {
      id: "security",
      title: "Security and claims",
      heading: "Last thing — security and past claims",
      fields: ["alarm", "priorBurglary"],
    },
  ],
  building: [
    {
      id: "you",
      title: "About you",
      heading: "Let's start with you",
      fields: ["birthYear", "gender", "maritalStatus"],
    },
    {
      id: "building",
      title: "Your building",
      heading: "Last thing — about the building",
      fields: ["suburb", "buildingValue", "geyserCover"],
    },
  ],
}

/**
 * The "yes" wording for each checkbox, taken verbatim from FSP's own label.
 *
 * Copied from their markup rather than written fresh, because these are three
 * different KINDS of question and inventing wording for any of them would
 * misstate a risk question on an insurance application:
 *
 *   - `priorBurglary` is CLAIMS HISTORY, not burglar bars. Their label is
 *     "I have suffered a burglary at this address" — the obvious guess from
 *     their field name `burglary` would have asked about security instead.
 *   - `alarm` is the only one of the three that is a security feature.
 *   - `geyserCover` ELECTS an optional cover; it says nothing about the
 *     property at all, so it changes what is covered rather than the price of
 *     a fixed cover.
 */
export const CHECK_AFFIRMATIVES = {
  alarm: "Yes, I have an alarm in working order",
  priorBurglary: "Yes, I have suffered a burglary at this address",
  geyserCover: "Yes, please include geyser cover",
} as const satisfies Partial<Record<QuickQuoteField, string>>

/**
 * One row of the "What we quoted on" summary.
 *
 * This panel tells the visitor what risk was declared on their behalf, so each
 * control kind has to read as the answer it actually is:
 *
 *  - checkbox — "Yes" / "No", never "—" and never the raw token "yes". The
 *    design's whole premise is that unticked IS the answer "no"; printing "—"
 *    said "unanswered", which is what that dash means in every other row, and
 *    a box ticked then unticked printed an EMPTY cell, because `??` does not
 *    fall through an empty string. So one answer rendered three ways, two of
 *    them wrong, on a declaration of prior loss.
 *  - number — money, matching the field's own hint, rather than bare 350000.
 *  - select — their option label, as before. Never the value: those are codes
 *    like "040", which is AUDI.
 */
export function summaryValue(
  field: QuickQuoteField,
  answer: string | undefined,
  opts: readonly { value: string; label: string }[] | undefined,
): string {
  const kind = FIELD_KINDS[field]
  if (kind.control === "checkbox") return (answer ?? "") !== "" ? "Yes" : "No"
  if (!answer) return "—"
  if (kind.control === "number") return formatRands(Number(answer))
  return opts?.find((o) => o.value === answer)?.label ?? answer
}

/**
 * Every field a view asks, in the order it asks them.
 *
 * Deliberately NOT `REQUIRED_FIELDS_BY_VIEW`. That list answers "without which
 * can the quote not be submitted", which excludes the checkboxes — an unticked
 * box is a complete answer. This one answers "what did we ask", which includes
 * them, and it is the right question for the restore replay: a visitor who
 * declared a prior burglary and then pressed "Change answers" must get that
 * declaration back, not silently lose it because it was not *required*.
 */
export function askedFields(view: QuickQuoteView): readonly QuickQuoteField[] {
  return WIZARD_STEPS_BY_VIEW[view].flatMap((step) => step.fields)
}

/**
 * How many cars one journey may quote.
 *
 * FSP's `addVehicle` pushes without limit, so this bound is ours. Three keeps
 * the step list readable and is well past the household case this is for.
 */
export const MAX_VEHICLES = 3

/**
 * Asked once per CAR.
 *
 * Measured after `addVehicle()` on quote-staging: `#tVehicles` held exactly
 * these five and nothing else. Everything else our wizard asks belongs to the
 * policy and is asked once.
 *
 * A THIRD list, `ADD_VEHICLE_GATE_FIELDS`, overlaps this one deliberately — it
 * is FSP's own validator's field list for the first car, not ours for later
 * cars. See its comment for why the two are not the same list.
 */
export const VEHICLE_FIELDS: readonly QuickQuoteField[] = [
  "vehicleYear",
  "make",
  "model",
  "vehicleUse",
  "overnightParking",
]

/**
 * Asked once per POLICY.
 *
 * `lastClaim`, `licenceYear` and `licenceType` are here — not in
 * VEHICLE_FIELDS — because they vanish from the DOM after the first add. A
 * wizard that replayed all four steps for car 2 would be writing into fields
 * that are not on the form.
 *
 * Three of these — `lastClaim`, `licenceYear`, `licenceType` — also appear in
 * `ADD_VEHICLE_GATE_FIELDS`. That overlap is deliberate and explained there:
 * FSP's validator walks them on the FIRST car only, before they leave the DOM.
 */
export const POLICY_FIELDS: readonly QuickQuoteField[] = [
  "birthYear",
  "gender",
  "maritalStatus",
  "suburb",
  "lastClaim",
  "licenceYear",
  "licenceType",
]

/**
 * A car already saved into FSP's model.
 *
 * Both halves are needed and neither can be derived from the other later:
 * `value` is what `set()` must write back on a replay, and `label` is what the
 * summary must show. By the time results render, the options list that mapped
 * "040" to "AUDI" belongs to a different vehicle and is gone — so a summary
 * built from values alone prints FSP's raw codes at a customer.
 */
export type SavedVehicle = Partial<
  Record<QuickQuoteField, { value: string; label: string }>
>

/**
 * The journey for `vehicleCount` cars, of which `appendedCarSteps` are still
 * owed to the visitor as their own step.
 *
 * Car 1 keeps today's four steps exactly — `buildSteps(1)` returns
 * `WIZARD_STEPS` itself, the SAME array reference, not a copy. That identity
 * is deliberate, not incidental, and the test asserts it with `toBe` as well
 * as `toEqual`: it is what makes the flag-off path provably unchanged rather
 * than merely equal-for-now, and a refactor that started returning a new
 * content-equal array would break the guarantee silently without that
 * assertion. Each owed car step asks only VEHICLE_FIELDS.
 *
 * ## Why two numbers rather than one
 *
 * "Cars FSP hold" and "car steps we owe" are the same number only while cars
 * arrive one add at a time. A "Change answers" restore replays several cars
 * into FSP's model in one go, and it owes NO steps for them: their vehicle
 * fields are flat and un-indexed and bind to the ACTIVE vehicle, so an earlier
 * car is not editable at all. Appending a step per restored car produced four
 * screens asking the same five questions, prefilled identically, every one of
 * them writing into the last car — so correcting the model on the step titled
 * "Your car" silently rewrote car 3.
 *
 * The caller therefore keeps `vehicleCount` for what it is good for (the
 * MAX_VEHICLES cap, the multi-car results summary) and passes the owed count
 * separately: an add increments both, a back-out decrements both, and a
 * restore sets owed to zero.
 *
 * The default keeps every pre-split call site meaning what it meant.
 *
 * ## Labels come from the CAR, not the position
 *
 * Once the two numbers can differ, the appended steps are the LAST cars, not
 * cars 2..n: a restore that landed two cars followed by one add owes one step,
 * and that step is car 3. Deriving the label from the array index would title
 * it "Car 2" and ask the visitor to describe a car FSP are not holding open.
 *
 * Also owns one copy rule: no step may claim to be last unless it is. The
 * driving step reads "Last thing — your licence", which stops being true the
 * moment a car step is appended after it — and that is precisely the step a
 * visitor is reading when they tick "I have more cars to insure". With no step
 * owed it is last again, and says so again.
 */
export function buildSteps(
  vehicleCount: number,
  appendedCarSteps: number = vehicleCount - 1,
): readonly WizardStep[] {
  const cars = Math.min(
    Math.max(Math.floor(vehicleCount) || 1, 1),
    MAX_VEHICLES,
  )
  // Capped at `cars - 1`: owing a step for a car FSP do not hold is the exact
  // mirror of the defect this argument exists to close.
  const owed = Math.min(Math.max(Math.floor(appendedCarSteps) || 0, 0), cars - 1)
  if (owed === 0) return WIZARD_STEPS

  const extra: WizardStep[] = []
  for (let n = cars - owed + 1; n <= cars; n++) {
    extra.push({
      id: `car-${n}`,
      title: `Car ${n}`,
      heading: n === cars ? `Last thing — car ${n}` : `Now car ${n}`,
      fields: VEHICLE_FIELDS,
    })
  }

  return [
    ...WIZARD_STEPS.map((step) =>
      step.id === "driving" ? { ...step, heading: "Your licence and claims" } : step,
    ),
    ...extra,
  ]
}

/** 0-1 progress for the step at `index`, counting the results step. */
export function stepProgress(index: number): number {
  return Math.min(1, Math.max(0, index / WIZARD_STEPS.length))
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ParsedQuote = {
  /**
   * Row position in FSP's rendered list — the identity everything keys off.
   *
   * Names collide, and so do their OfferingIds: a duplicate made the lead
   * lookup return the wrong row and painted two "Best price" badges. Position
   * is unique by construction.
   */
  index: number
  /** Their OfferingId, kept for diagnostics. Not used as a key. */
  offeringId: string
  insurer: string
  logoUrl: string
  premium: number
  premiumLabel: string
  excessLabel: string
}

/**
 * Summary stats for the benchmarking line above the results.
 *
 * Hippo lead with "your best price is R1228 better than average", which is the
 * single cheapest thing you can do to make a list of numbers feel like a
 * result. It needs nothing FSP do not already render.
 */
export function summariseQuotes(quotes: readonly ParsedQuote[]) {
  if (quotes.length === 0) return null
  const premiums = quotes.map((q) => q.premium).filter((p) => p > 0)
  if (premiums.length === 0) return null

  const best = Math.min(...premiums)
  const average = premiums.reduce((a, b) => a + b, 0) / premiums.length
  return {
    count: quotes.length,
    /** How many carried a usable premium — what `average` is computed over. */
    priced: premiums.length,
    best,
    average,
    /** Rands per month the best quote saves against the average. */
    savingVsAverage: Math.max(0, average - best),
    /** Whole-percent better than average, floored at 0. */
    percentBetter: average > 0 ? Math.max(0, Math.round((1 - best / average) * 100)) : 0,
  }
}

/**
 * Collapses the repeated insurer name in FSP's offering titles.
 *
 * Their title attribute is "<Insurer> <OfferingName>", and the offering name
 * usually begins with the insurer again — "Virseker Virseker", "1st For Women
 * 1st For Women", "Absa Absa Plus9". Printed raw it reads like a stutter.
 * Titles without a repeat ("Auto and General Broker Express") are untouched.
 */
export function tidyInsurerName(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return title.trim()
  // Longest repeated prefix wins, so "1st For Women" collapses as a unit
  // rather than leaving "For Women 1st For Women" behind.
  for (let k = Math.floor(words.length / 2); k >= 1; k--) {
    const head = words.slice(0, k).join(" ").toLowerCase()
    const next = words.slice(k, k * 2).join(" ").toLowerCase()
    if (head === next) return words.slice(k).join(" ")
  }
  return words.join(" ")
}

/**
 * Rands, matching the format FSP print beside them.
 *
 * Intl's ZAR output uses a non-breaking space ("R 184"), which sits badly next
 * to their own "R730.43" in the same row.
 */
export function formatRands(amount: number, decimals = 0): string {
  return `R${amount.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`
}

export type QuoteSort = "cheapest" | "dearest"

/**
 * Orders quotes for display.
 *
 * Cheapest first by default — the whole reason someone compares. Quotes we
 * could not price sink to the bottom rather than sorting as free.
 */
export function sortQuotes(
  quotes: readonly ParsedQuote[],
  order: QuoteSort,
): ParsedQuote[] {
  return [...quotes].sort((a, b) => {
    if (a.premium <= 0 && b.premium <= 0) return 0
    if (a.premium <= 0) return 1
    if (b.premium <= 0) return -1
    return order === "cheapest" ? a.premium - b.premium : b.premium - a.premium
  })
}

/** Parses "R1 234.56" / "R752.96" into a number. Returns 0 when unparseable. */
export function parsePremium(text: string): number {
  const cleaned = text.replace(/[^\d.,]/g, "").replace(/\s/g, "").replace(/,/g, "")
  const value = Number.parseFloat(cleaned)
  return Number.isFinite(value) ? value : 0
}

// ---------------------------------------------------------------------------
// Waiting-screen stages
// ---------------------------------------------------------------------------

/**
 * What the wait screen is allowed to say, and when.
 *
 * `at` is the elapsed-time floor; `minQuotes` is the evidence floor. A stage
 * has to clear BOTH, so any copy that makes a claim about the panel has to be
 * earned by rows actually landing rather than asserted on a timer.
 *
 * This lives here rather than in the component because it is the one part of
 * that screen which can state something false, and a node-environment test
 * suite cannot render the component to check it.
 */
export const WAITING_STAGES = [
  { at: 0, minQuotes: 0, label: "Sending your details to our panel" },
  { at: 3000, minQuotes: 0, label: "Insurers are pricing your risk" },
  { at: 9000, minQuotes: 0, label: "Still going — some insurers take a little longer" },
  // "Nearly there, hang tight" used to sit here. It was the only stage making a
  // claim about proximity to finishing, and it fired on the clock at exactly
  // the moment things had usually gone wrong.
  //
  // "the last few" is that same claim wearing different clothes: it says the
  // rest have already answered. Chosen on elapsed time alone it appeared with
  // zero rows in — telling the visitor most of the panel had replied when none
  // of it had, at the point a run is most likely to be failing.
  { at: 25000, minQuotes: 1, label: "Still waiting on the last few insurers" },
] as const

export type WaitingStage = (typeof WAITING_STAGES)[number]

/**
 * The furthest stage whose clock AND evidence bar are both satisfied.
 *
 * Falls back to the last truthful stage rather than promoting on time alone,
 * so a stalled run says "some insurers take a little longer" instead of
 * claiming the panel has nearly finished.
 */
export function waitingStage(elapsedMs: number, quoteCount: number): WaitingStage {
  return (
    [...WAITING_STAGES]
      .reverse()
      .find((s) => elapsedMs >= s.at && quoteCount >= s.minQuotes) ?? WAITING_STAGES[0]
  )
}

/**
 * The furthest step the current answers actually entitle someone to be on.
 *
 * History entries outlive the journey that wrote them. "Change answers"
 * reloads in place, so the entries BEHIND the restored one still carry the
 * step indices of a journey that no longer exists — and a popstate that
 * trusted them walked the visitor FORWARD, past the step holding the suburb
 * gate, into a form that could not be quoted. They then reached "The insurers
 * aren't responding", which is the false statement three rounds of this branch
 * were spent removing.
 *
 * So a popped step index is a request, never an authority: it is clamped to
 * the first step that is not fully answered. This defends every route to a
 * stale entry, including ones nobody thought of — unlike stamping a journey
 * id, which only invalidates entries somebody remembered to stamp.
 *
 * `steps` is required, not defaulted to WIZARD_STEPS: a default would let the
 * wizard keep passing the one-car list on a two-car journey and clamp the
 * visitor backwards out of their second car, silently. Making it required
 * forces every call site to be revisited when the step list can now vary.
 */
export function furthestReachableStep(
  answers: Partial<Record<QuickQuoteField, string>>,
  steps: readonly WizardStep[],
): number {
  const firstIncomplete = steps.findIndex(
    (step) => !step.fields.every((f) => !isUnanswered(f, answers)),
  )
  return firstIncomplete === -1 ? steps.length - 1 : firstIncomplete
}

/**
 * How long to wait before revealing results, in ms.
 *
 * Three deliberately distinct cases:
 *   their signal has FIRED   -> a beat for the DOM to paint the last row
 *   their signal EXISTS      -> wait for it, but not forever
 *   no signal at all         -> the original blind debounce
 *
 * Lives here rather than inline in the component because it decides when a
 * SUPERLATIVE about a financial product is asserted, a node-environment suite
 * cannot render a component to check it, and the inline version had no test
 * standing between it and the incident it was written for: revealing at 16.4s
 * while their signal still read false badged R897.71 as "Best price" with the
 * real cheapest, R729.60, still in flight.
 */
export function settleDelay(
  panelDone: boolean,
  hasSignal: boolean,
  timings: { paint: number; signalSilent: number; blind: number },
): number {
  if (panelDone) return timings.paint
  return hasSignal ? timings.signalSilent : timings.blind
}

/** One insurer's row in the arrival choreography. */
export type ArrivalSlot = {
  quote: ParsedQuote
  /** Row position while the panel is still answering — the order FSP returned. */
  arrivedAt: number
  /** Row position after the panel completes and the list re-sorts by price. */
  settlesAt: number
  /** The single cheapest priced quote. Never true before the panel completes. */
  isBest: boolean
}

/**
 * Where each arrived quote sits before and after the re-sort.
 *
 * The wait screen shows quotes in the order FSP hands them over, then reorders
 * the whole set by price once the panel is done. This function owns both
 * positions so the component only animates between two numbers it is given —
 * the ordering decision is falsifiable here rather than buried in a transform.
 *
 * TWO RULES, both of which have been got wrong before on this surface:
 *
 * 1. NOTHING RE-SORTS EARLY. While quotes are still landing, `settlesAt`
 *    equals `arrivedAt`. A list that reshuffles under the reader on every
 *    arrival is unreadable, and worse, it implies a final ordering that the
 *    missing insurers can still overturn.
 *
 * 2. NOTHING IS "BEST" EARLY. `isBest` is false for every row until
 *    `panelComplete`. Cheapest-so-far is not cheapest: settleDelay's own
 *    docstring records a run where R897.71 wore the badge while the real
 *    cheapest, R729.60, was still in flight. The badge is a claim about the
 *    whole panel, so it cannot be made before the whole panel has answered.
 *
 * Unpriced rows (premium <= 0) sort to the bottom via sortQuotes and can never
 * be best, matching how the results screen already treats them.
 */
export function arrivalPlan(
  quotes: readonly ParsedQuote[],
  panelComplete: boolean,
): ArrivalSlot[] {
  if (quotes.length === 0) return []

  const settledOrder = sortQuotes(quotes, "cheapest")
  // Identity is row position (ParsedQuote.index), never name or premium —
  // both collide across a panel.
  const settledPosition = new Map(settledOrder.map((q, i) => [q.index, i]))

  const bestIndex =
    panelComplete && settledOrder[0] && settledOrder[0].premium > 0
      ? settledOrder[0].index
      : null

  return quotes.map((quote, arrivedAt) => ({
    quote,
    arrivedAt,
    settlesAt: panelComplete ? (settledPosition.get(quote.index) ?? arrivedAt) : arrivedAt,
    isBest: bestIndex !== null && quote.index === bestIndex,
  }))
}

/**
 * Whether to hold the results screen back so the re-sort can finish playing.
 *
 * When FSP signal the panel is done, arm() settles after PAINT_MS (400ms) and
 * the results screen replaces the arrival. The re-sort transition is 900ms, so
 * the arrival was being unmounted a third of the way through the one piece of
 * choreography it exists for: measured on staging, the list handed over with
 * five rows still in FSP's return order and no badge, and the visitor simply
 * saw a finished sorted list appear.
 *
 * This holds the HANDOVER, not the settle — settleDelay's timings still mean
 * what they meant, and nothing about when we decide the panel is finished
 * changes.
 *
 * Deliberately returns false when `panelComplete` is false. The hold must never
 * depend on a signal that might not arrive: if FSP never confirm, the journey
 * proceeds exactly as it did before. It also returns false below two rows,
 * because one row cannot reorder and holding for it would add a second of dead
 * air to the fastest possible run.
 */
export function shouldHoldForResort(
  panelComplete: boolean,
  arrivedCount: number,
  resortPlayed: boolean,
): boolean {
  if (!panelComplete) return false
  if (arrivedCount < 2) return false
  return !resortPlayed
}
