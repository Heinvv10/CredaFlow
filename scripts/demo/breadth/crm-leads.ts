/**
 * The CRM's prospects: fictional people who enquired but are not loan
 * personas, each with the path their lead takes through the pipeline. Days
 * are business days after the lead's creation day; the creation day is
 * anchored to the window (`start` = after the first business day, `end` =
 * before the last full business day) so the board looks the same whenever the
 * bake runs: old leads are lost or converted, recent ones are still new.
 *
 * Identity (names, phones, e-mail, and the ID number the conversion form asks
 * for) is drawn deterministically from the persona catalogues and never
 * matches a persona. Website-form leads get no Contact
 * from the product, so they cannot be e-mailed from the CRM; only
 * staff-captured leads have "email" steps.
 */
import { minimumLivingExpense } from "../../../lib/affordability/mle"
import { FEMALE_FIRST_NAMES, MALE_FIRST_NAMES, SURNAMES } from "../personas/catalog"
import { PERSONAS } from "../personas"
import { createRng } from "../personas/prng"
import { buildSaIdNumber } from "../personas/sa-id"

/** How the lead arrives: captured by staff, the website contact form, or the website application form (with an agent code). */
export type Origin =
  | { kind: "staff"; source: "WALK_IN" | "SOCIAL" | "MANUAL" | "WHATSAPP" | "REFERRAL" }
  | { kind: "contact-form" }
  | { kind: "website-apply"; referralCode: string }

export type Step =
  | "assign" | "call" | "no-answer" | "callback" | "task" | "task-done" | "qualify" | "email"
  | "proposal" | "meeting" | "convert"
  | { lost: "TOO_EXPENSIVE" | "WENT_ELSEWHERE" | "NOT_QUALIFIED" | "NO_RESPONSE" | "PRODUCT_MISMATCH" }

export interface LeadSpec {
  key: string
  origin: Origin
  anchor: { start: number } | { end: number }
  owner: "officer" | "officer2"
  /** [business days after creation, step] in order. */
  path: ReadonlyArray<readonly [number, Step]>
  amountRands: number
  incomeRands: number
}

const L = (n: number) => ({ lost: n === 0 ? "TOO_EXPENSIVE" : n === 1 ? "WENT_ELSEWHERE" : n === 2 ? "NOT_QUALIFIED" : n === 3 ? "NO_RESPONSE" : "PRODUCT_MISMATCH" } as const)

export const LEADS: readonly LeadSpec[] = [
  // lost along the way
  { key: "L01", origin: { kind: "contact-form" }, anchor: { start: 3 }, owner: "officer", amountRands: 6_000, incomeRands: 9_500,
    path: [[0, "assign"], [1, "call"], [3, "qualify"], [6, L(0)]] },
  { key: "L02", origin: { kind: "staff", source: "WALK_IN" }, anchor: { start: 9 }, owner: "officer2", amountRands: 20_000, incomeRands: 14_000,
    path: [[0, "assign"], [0, "call"], [2, "qualify"], [2, "email"], [3, "proposal"], [9, L(1)]] },
  { key: "L03", origin: { kind: "staff", source: "SOCIAL" }, anchor: { start: 21 }, owner: "officer2", amountRands: 8_000, incomeRands: 4_200,
    path: [[0, "assign"], [1, "call"], [2, L(2)]] },
  { key: "L04", origin: { kind: "contact-form" }, anchor: { start: 38 }, owner: "officer", amountRands: 5_000, incomeRands: 11_000,
    path: [[0, "assign"], [1, "no-answer"], [3, "no-answer"], [5, "no-answer"], [12, L(3)]] },
  { key: "L05", origin: { kind: "staff", source: "MANUAL" }, anchor: { start: 55 }, owner: "officer2", amountRands: 60_000, incomeRands: 26_000,
    path: [[0, "assign"], [0, "call"], [1, "meeting"], [5, L(4)]] },
  { key: "L06", origin: { kind: "website-apply", referralCode: "SOWETO-CP" }, anchor: { start: 70 }, owner: "officer2", amountRands: 7_000, incomeRands: 10_500,
    path: [[0, "assign"], [1, "call"], [2, "qualify"], [4, "proposal"], [11, L(1)]] },
  // converted into a client and a submitted application
  { key: "L07", origin: { kind: "staff", source: "WALK_IN" }, anchor: { end: 14 }, owner: "officer2", amountRands: 12_000, incomeRands: 19_000,
    path: [[0, "assign"], [0, "call"], [1, "task"], [2, "qualify"], [3, "task-done"], [4, "proposal"], [6, "meeting"], [8, "convert"]] },
  { key: "L08", origin: { kind: "website-apply", referralCode: "TSHEPO-FLD" }, anchor: { end: 11 }, owner: "officer", amountRands: 9_000, incomeRands: 15_500,
    path: [[0, "assign"], [1, "call"], [2, "qualify"], [4, "proposal"], [6, "task"], [8, "convert"]] },
  { key: "L09", origin: { kind: "staff", source: "REFERRAL" }, anchor: { end: 9 }, owner: "officer2", amountRands: 15_000, incomeRands: 22_000,
    path: [[0, "assign"], [0, "call"], [1, "qualify"], [2, "email"], [2, "proposal"], [5, "meeting"], [7, "convert"]] },
  // proposal sent
  { key: "L10", origin: { kind: "staff", source: "MANUAL" }, anchor: { end: 12 }, owner: "officer", amountRands: 10_000, incomeRands: 17_000,
    path: [[0, "assign"], [1, "call"], [3, "qualify"], [4, "email"], [5, "proposal"], [8, "task"]] },
  { key: "L11", origin: { kind: "staff", source: "WHATSAPP" }, anchor: { end: 8 }, owner: "officer2", amountRands: 18_000, incomeRands: 24_000,
    path: [[0, "assign"], [0, "call"], [2, "qualify"], [3, "email"], [4, "proposal"], [5, "task"]] },
  { key: "L12", origin: { kind: "website-apply", referralCode: "FB-WINTER26" }, anchor: { end: 7 }, owner: "officer", amountRands: 6_500, incomeRands: 12_000,
    path: [[0, "assign"], [1, "call"], [2, "qualify"], [4, "proposal"]] },
  // qualified
  { key: "L13", origin: { kind: "staff", source: "WALK_IN" }, anchor: { end: 6 }, owner: "officer2", amountRands: 11_000, incomeRands: 16_500,
    path: [[0, "assign"], [0, "call"], [2, "qualify"], [2, "email"], [3, "task"]] },
  { key: "L14", origin: { kind: "contact-form" }, anchor: { end: 5 }, owner: "officer", amountRands: 8_500, incomeRands: 13_000,
    path: [[0, "assign"], [1, "call"], [3, "qualify"], [4, "meeting"]] },
  { key: "L15", origin: { kind: "staff", source: "SOCIAL" }, anchor: { end: 4 }, owner: "officer2", amountRands: 25_000, incomeRands: 31_000,
    path: [[0, "assign"], [1, "call"], [2, "qualify"], [3, "meeting"]] },
  // contacted
  { key: "L16", origin: { kind: "contact-form" }, anchor: { end: 4 }, owner: "officer", amountRands: 4_000, incomeRands: 8_800,
    path: [[0, "assign"], [1, "call"], [2, "callback"]] },
  { key: "L17", origin: { kind: "staff", source: "MANUAL" }, anchor: { end: 3 }, owner: "officer2", amountRands: 14_000, incomeRands: 20_000,
    path: [[0, "assign"], [1, "call"], [1, "email"], [2, "task"]] },
  { key: "L18", origin: { kind: "staff", source: "WHATSAPP" }, anchor: { end: 2 }, owner: "officer", amountRands: 9_500, incomeRands: 14_500,
    path: [[0, "assign"], [1, "no-answer"], [2, "call"]] },
  { key: "L19", origin: { kind: "contact-form" }, anchor: { end: 2 }, owner: "officer2", amountRands: 7_500, incomeRands: 12_500,
    path: [[0, "assign"], [1, "call"]] },
  // new: still waiting for a first contact
  { key: "L20", origin: { kind: "contact-form" }, anchor: { end: 1 }, owner: "officer", amountRands: 5_500, incomeRands: 9_000, path: [] },
  { key: "L21", origin: { kind: "staff", source: "WALK_IN" }, anchor: { end: 1 }, owner: "officer2", amountRands: 13_000, incomeRands: 18_500,
    path: [[0, "assign"]] },
  { key: "L22", origin: { kind: "contact-form" }, anchor: { end: 0 }, owner: "officer", amountRands: 6_000, incomeRands: 10_000, path: [] },
  { key: "L23", origin: { kind: "website-apply", referralCode: "TSHEPO-FLD" }, anchor: { end: 0 }, owner: "officer2", amountRands: 8_000, incomeRands: 13_500, path: [] },
]

export interface LeadPerson {
  firstName: string
  lastName: string
  gender: "MALE" | "FEMALE"
  phone: string
  email: string
  employerName: string
  /** Synthetic: sequence 4001+ (female) or 9001+ (male), far from the personas' 0001+/5001+. */
  idNumber: string
  incomeCents: number
  /** Declared expenses, never below the Regulation 23A minimum for the income. */
  expensesCents: number
}

const PERSONA_NAMES = new Set(PERSONAS.map((p) => `${p.firstName} ${p.lastName}`))
const EMPLOYERS = ["Gauteng Freight Lines (demo)", "Highveld Retail Group (demo)", "Moja Security Services (demo)", "Tswane Medical Supplies (demo)"]

export function leadPerson(spec: LeadSpec, index: number): LeadPerson {
  const rng = createRng(`crm-lead-${spec.key}`)
  let firstName = ""
  let lastName = ""
  let gender: "MALE" | "FEMALE" = "FEMALE"
  for (let tries = 0; tries < 20; tries++) {
    gender = rng.chance(0.5) ? "MALE" : "FEMALE"
    firstName = rng.pick(gender === "MALE" ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES)
    lastName = rng.pick(SURNAMES)
    if (!PERSONA_NAMES.has(`${firstName} ${lastName}`)) break
  }
  const incomeCents = spec.incomeRands * 100
  const employerName = rng.pick(EMPLOYERS)
  const dateOfBirth = `${rng.int(1970, 1999)}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`
  return {
    firstName, lastName, gender,
    phone: `+2760002${String(index + 1).padStart(4, "0")}`,
    email: `${firstName}.${lastName}.${spec.key}`.toLowerCase().replace(/[^a-z0-9.]/g, "") + "@prospect.invalid",
    employerName,
    idNumber: buildSaIdNumber({ dateOfBirth, gender, index: 4001 + index }),
    incomeCents,
    expensesCents: Math.max(Math.round(incomeCents * 0.45 / 100) * 100, minimumLivingExpense(incomeCents) + 50_000),
  }
}
