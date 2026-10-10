/**
 * The origination storyline, driven only through the app's HTTP API:
 *
 *   capture → documents → identity → bureau → affordability → decision
 *   → pasq → agreement → mandate → disbursement
 *
 * Steps run in the order the routes enforce and are spread over SA business
 * days (day 0 = `start`). The timetable is a list of dated actions
 * (`originationActions`), so the day-stepped simulator can interleave one
 * persona's actions with crons and other personas; `runOrigination` simply
 * walks the list for one persona. `stopAfter` parks the application after any
 * step, so later scenarios can leave applications mid-pipeline. A declined
 * application ends at `decision`; `draft` saves the application unsubmitted
 * and ends at `capture`.
 *
 * Parking after `agreement` or `mandate` leaves a debit-order agreement whose
 * schedule stops being current at SAST midnight; signing or paying it out on a
 * later day needs staff to regenerate it first (the product's rule, not ours).
 *
 * The clock only moves forward, so one process can run many personas only in
 * start-date order (or interleaved by the caller); a slot already behind the
 * clock is taken at the current time.
 */
import type { Persona } from "../personas"
import { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { activatePortal, captureClient, submitApplication } from "./capture"
import { ensureStaffSessions, type OriginationContext } from "./context"
import { assessAffordability, decide, startReview, type AffordabilityResult, type Decision } from "./decision"
import { awaitExtraction, recordInPersonVerification, retryFailedExtractions, uploadDocuments, verifyDocuments } from "./documents"
import {
  acknowledgePasq,
  countersignAgreement,
  disburse,
  generateAgreement,
  issuePasq,
  signAgreement,
  signDebitMandate,
} from "./signing"
import { ensureCreditPolicy } from "./tenant-setup"
import { Timeline } from "./timeline"

export const ORIGINATION_STEPS = [
  "capture",
  "documents",
  "identity",
  "bureau",
  "affordability",
  "decision",
  "pasq",
  "agreement",
  "mandate",
  "disbursement",
] as const

export type OriginationStep = (typeof ORIGINATION_STEPS)[number]

export interface OriginationOptions {
  /** Day 0, YYYY-MM-DD (moved to the next SA business day if it is not one). */
  start: string
  stopAfter?: OriginationStep
  /** Defaults from the persona's storyline. */
  decision?: Decision
  /** Save the application as a DRAFT and stop after capture. */
  draft?: boolean
}

export interface OriginationResult {
  personaId: string
  clientId: string
  applicationId: string
  reference: string
  status: "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "DECLINED" | "DISBURSED"
  lastStep: OriginationStep
  loanRef: string | null
  loanId: string | null
}

/** Everything a later action needs from an earlier one; JSON-serialisable so a run can resume. */
export interface OriginationState {
  personaId: string
  clientId: string | null
  applicationId: string | null
  reference: string | null
  status: OriginationResult["status"] | "NEW"
  lastStep: OriginationStep | null
  loanRef: string | null
  loanId: string | null
  docIds: string[]
  pasqSha: string | null
  affordability: AffordabilityResult | null
}

/** The borrower's portal session; re-established by signing in when a resumed run has none. */
export class PortalSession {
  private client: SimClient | null = null

  constructor(private readonly p: Persona, private readonly password: string) {}

  async activate(): Promise<SimClient> {
    this.client = await activatePortal(this.p, this.password)
    return this.client
  }

  async get(): Promise<SimClient> {
    if (this.client?.user && (await this.client.session())) return this.client
    this.client = new SimClient()
    await this.client.loginClient(this.p.email, this.password)
    log(`${this.p.id}: portal signed in`)
    return this.client
  }
}

export interface OriginationAction {
  step: OriginationStep
  /** Business-day offset from day 0. */
  day: number
  /** SAST wall time, HH:MM. */
  at: string
  /** The last action of its step: the application is parked here when the step is `stopAfter`. */
  endsStep: boolean
  run: (ctx: OriginationContext, p: Persona, s: OriginationState, portal: PortalSession) => Promise<void>
}

const DECLINING_STORYLINES: ReadonlySet<Persona["storyline"]> = new Set(["live-affordability-decline", "declined"])

export function defaultDecision(p: Persona): Decision {
  return DECLINING_STORYLINES.has(p.storyline) ? "decline" : "approve"
}

export function newOriginationState(personaId: string): OriginationState {
  return {
    personaId, clientId: null, applicationId: null, reference: null, status: "NEW", lastStep: null,
    loanRef: null, loanId: null, docIds: [], pasqSha: null, affordability: null,
  }
}

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`origination state has no ${what}; an earlier step did not run`)
  return value
}

type Run = OriginationAction["run"]
const act = (step: OriginationStep, day: number, at: string, run: Run, endsStep = false): OriginationAction =>
  ({ step, day, at, run, endsStep })

/** The full timetable; `originationActions` cuts it at the stop point. */
function timetable(opts: OriginationOptions, decision: Decision): OriginationAction[] {
  const app = (s: OriginationState) => need(s.applicationId, "application")
  return [
    act("capture", 0, "08:45", async (ctx) => {
      await ensureStaffSessions(ctx)
      await ensureCreditPolicy(ctx)
    }),
    act("capture", 0, "09:00", async (ctx, p, s) => {
      s.clientId = await captureClient(ctx, p)
    }),
    act("capture", 0, "09:20", async (ctx, p, s) => {
      const created = await submitApplication(ctx, p, need(s.clientId, "client"), !opts.draft)
      s.applicationId = created.id
      s.reference = created.reference
      s.status = opts.draft ? "DRAFT" : "SUBMITTED"
    }),
    act("capture", 0, "09:40", async (_ctx, _p, _s, portal) => {
      await portal.activate()
    }, true),
    // documents: uploaded from the portal on day 0, verified by the officer on day 1
    act("documents", 0, "10:00", async (ctx, p, s, portal) => {
      const client = await portal.get()
      s.docIds = await uploadDocuments(ctx, client, p, new Timeline(opts.start).date(0))
      await awaitExtraction(client, need(s.clientId, "client"), s.docIds)
    }),
    act("documents", 1, "09:00", async (ctx, _p, s, portal) => {
      await ensureStaffSessions(ctx)
      const client = await portal.get()
      const extracted = await awaitExtraction(client, need(s.clientId, "client"), s.docIds)
      await verifyDocuments(ctx, need(s.clientId, "client"), await retryFailedExtractions(ctx, client, need(s.clientId, "client"), extracted))
    }, true),
    act("identity", 1, "10:00", async (ctx, p, s) => {
      await recordInPersonVerification(ctx, p, need(s.clientId, "client"))
    }, true),
    act("bureau", 1, "10:30", async (ctx, _p, s) => {
      await startReview(ctx, app(s))
      s.status = "UNDER_REVIEW"
    }, true),
    act("affordability", 1, "11:00", async (ctx, _p, s) => {
      s.affordability = await assessAffordability(ctx, need(s.clientId, "client"), app(s))
    }, true),
    act("decision", 2, "10:00", async (ctx, p, s) => {
      await ensureStaffSessions(ctx)
      s.status = await decide(ctx, p, app(s), decision, need(s.affordability, "affordability assessment"))
    }, true),
    act("pasq", 2, "10:30", async (ctx, _p, s) => {
      s.pasqSha = await issuePasq(ctx, app(s))
    }),
    act("pasq", 2, "13:00", async (_ctx, _p, s, portal) => {
      s.pasqSha = await acknowledgePasq(await portal.get(), app(s), need(s.pasqSha, "issued PASQ"))
    }, true),
    // For a debit order the agreement's schedule is only current on the SAST
    // day it was generated (affordabilityContractCanBeDisbursed): generation,
    // both signatures, the mandate and payout all happen on day 3.
    act("agreement", 3, "08:30", async (ctx, _p, s) => {
      await ensureStaffSessions(ctx)
      await generateAgreement(ctx, app(s))
    }),
    act("agreement", 3, "09:00", async (_ctx, p, s, portal) => {
      await signAgreement(await portal.get(), p, app(s), need(s.pasqSha, "acknowledged PASQ"))
    }),
    act("agreement", 3, "09:30", async (ctx, _p, s) => {
      await countersignAgreement(ctx, app(s))
    }, true),
    act("mandate", 3, "09:45", async (_ctx, p, s, portal) => {
      await signDebitMandate(await portal.get(), p, app(s))
    }, true),
    act("disbursement", 3, "11:00", async (ctx, _p, s) => {
      const loan = await disburse(ctx, app(s))
      s.loanId = loan.loanId
      s.loanRef = loan.loanRef
      s.status = "DISBURSED"
    }, true),
  ].map((a) => ({ ...a, run: wrapStep(a.step, a.endsStep, a.run) }))
}

/** Records the step a finished action completed. */
function wrapStep(step: OriginationStep, endsStep: boolean, run: Run): Run {
  return async (ctx, p, s, portal) => {
    await run(ctx, p, s, portal)
    if (endsStep) s.lastStep = step
  }
}

/** The dated actions for one persona, up to and including the stop point. */
export function originationActions(p: Persona, opts: OriginationOptions): OriginationAction[] {
  const decision = opts.decision ?? defaultDecision(p)
  let last: OriginationStep = opts.stopAfter ?? "disbursement"
  if (opts.draft) last = "capture"
  if (decision === "decline" && ORIGINATION_STEPS.indexOf(last) > ORIGINATION_STEPS.indexOf("decision")) last = "decision"
  const lastIndex = ORIGINATION_STEPS.indexOf(last)
  return timetable(opts, decision).filter((a) => ORIGINATION_STEPS.indexOf(a.step) <= lastIndex)
}

export async function runOrigination(
  ctx: OriginationContext,
  p: Persona,
  opts: OriginationOptions,
): Promise<OriginationResult> {
  const t = new Timeline(opts.start)
  const actions = originationActions(p, opts)
  log(`${p.id}: origination from ${t.day0} (${opts.decision ?? defaultDecision(p)}), stopping after ${actions[actions.length - 1].step}`)

  const s = newOriginationState(p.id)
  const portal = new PortalSession(p, ctx.creds.portalPassword)
  for (const a of actions) {
    await t.at(a.day, a.at)
    await a.run(ctx, p, s, portal)
  }
  if (s.status === "NEW" || s.lastStep === null) throw new Error(`${p.id}: origination finished without a status`)
  return {
    personaId: p.id,
    clientId: need(s.clientId, "client"),
    applicationId: need(s.applicationId, "application"),
    reference: need(s.reference, "reference"),
    status: s.status,
    lastStep: s.lastStep,
    loanRef: s.loanRef,
    loanId: s.loanId,
  }
}
