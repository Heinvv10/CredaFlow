/**
 * The bake's breadth: every staff-app module beyond origination and servicing,
 * as dated storylines on the same event queue (T5 of the demo-simulator plan).
 *
 *   setup.ts       staff, branches, modules on (first business day, 08:15)
 *   crm.ts         leads through the pipeline; cross-sell opportunity work
 *   referrals.ts   agents, attributed borrowers, website referrals, commissions
 *   insurance.ts   funeral catalogue, FAIS sales, claims, advisor commission
 *                  (only for a lender with an FSP number: one without sells none)
 *   compliance.ts  complaints, DSAR, breach register, COI, fit-and-proper, TCF
 *   inbox.ts       client e-mail threads worked in the shared inbox
 *   bureau.ts      adverse-listing confirmations (the files come from the crons)
 *
 * The second credit officer also runs the origination of every other
 * background persona (`originationActors`), so the applications, audit trail
 * and advisor report show more than one person at work.
 */
import { demoLender } from "../../../prisma/demo-lender"
import type { Persona } from "../personas"
import type { OriginationContext } from "../scenarios/context"
import type { Sim } from "../simulate/context"
import { fromStart, step, type Breadth } from "./context"
import { scheduleBureau } from "./bureau"
import { scheduleCompliance } from "./compliance"
import { scheduleCrm, scheduleOpportunityWork } from "./crm"
import { scheduleInbox } from "./inbox"
import { scheduleInsurance } from "./insurance"
import { scheduleReferrals } from "./referrals"
import { enableOperatorModules, runSetup } from "./setup"
import { loadBreadthStaff } from "./staff"

const SETUP_EVENT = "breadth:setup:lender-setup"

/** Background personas whose origination the second credit officer handles. */
const secondOfficerTakes = (p: Persona): boolean => p.kind === "background" && Number(p.id.slice(3)) % 2 === 1

export function scheduleBreadth(sim: Sim): Breadth {
  // On resume the staff exist once setup has run; a fresh bake creates them at 08:15 on day one.
  const b: Breadth = { sim, staff: sim.state.done.includes(SETUP_EVENT) ? loadBreadthStaff() : null }
  step(b, "setup", "lender-setup", fromStart(b, 0), "08:15", () => runSetup(b))
  step(b, "setup", "operator-modules", fromStart(b, 0), "08:25", () => enableOperatorModules(b))
  scheduleReferrals(b)
  scheduleCrm(b)
  scheduleOpportunityWork(b)
  if (demoLender().identity.fscaNumber) scheduleInsurance(b)
  scheduleCompliance(b)
  scheduleInbox(b)
  scheduleBureau(b)

  let officer2Ctx: OriginationContext | null = null
  sim.originationActors = (p: Persona): OriginationContext => {
    if (!secondOfficerTakes(p) || !b.staff) return sim.actors
    officer2Ctx ??= { ...sim.actors, officer: b.staff.officer2.client, creds: { ...sim.actors.creds, officer: b.staff.officer2.creds } }
    return officer2Ctx
  }
  return b
}
