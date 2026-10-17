/**
 * The actors a scenario drives: a credit officer and an admin (staff, each
 * with its own session) plus the seed credentials. Borrowers get their own
 * SimClient per persona (scenarios/capture.ts).
 *
 * Roles follow the route guards: CREDIT_OFFICER captures clients and
 * applications, verifies documents, starts the bureau review and assesses
 * affordability; ADMIN (above LOAN_ADMIN) records the in-person identity
 * check, the compliance evidence and the decision, and countersigns; the
 * `disburser` (or, without one, the ADMIN) pays out.
 */
import path from "node:path"

import { SimClient } from "../sim/api"
import { readSeedCredentials, type SeedCredentials, type StaffCredentials } from "../sim/credentials"
import { log } from "../sim/env"

export interface OriginationContext {
  officer: SimClient
  admin: SimClient
  /**
   * Who pays out (POST …/disburse); unset = the admin. The simulator sets a
   * LOAN_ADMIN here (servicing/setup.ts), so the approver never disburses and
   * a lender with segregation of duties on still simulates.
   */
  disburser?: { client: SimClient; creds: StaffCredentials }
  creds: SeedCredentials
  /** Where per-persona specimen documents are generated. */
  specimensRoot: string
}

export const DEFAULT_SPECIMENS_ROOT = path.resolve(__dirname, "..", ".out", "sim-specimens")

export function createOriginationContext(specimensRoot = DEFAULT_SPECIMENS_ROOT): OriginationContext {
  return {
    officer: new SimClient(),
    admin: new SimClient(),
    creds: readSeedCredentials(),
    specimensRoot,
  }
}

async function ensureStaff(client: SimClient, who: StaffCredentials): Promise<void> {
  if (client.user && (await client.session())) return
  await client.loginStaff(who.email, who.password, who.totpSecret)
  log(`signed in ${client.user?.role} ${client.user?.email}`)
}

/**
 * Signs both staff actors in, or keeps their sessions when still valid. Call
 * after the clock is at the scenario's time: the TOTP code is generated for
 * the app's clock, and a session older than 30 simulated days has expired.
 */
export async function ensureStaffSessions(ctx: OriginationContext): Promise<void> {
  await ensureStaff(ctx.officer, ctx.creds.officer)
  await ensureStaff(ctx.admin, ctx.creds.admin)
  if (ctx.disburser) await ensureStaff(ctx.disburser.client, ctx.disburser.creds)
}
