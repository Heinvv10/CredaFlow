/**
 * Lender configuration the servicing storylines need, done through Settings
 * the way a lender's admin would before collecting (all ADMIN, all idempotent):
 *
 *   - Settings → Email (POST /api/email/config): SMTP pointed at the sim's
 *     sink (sim/smtp-sink.ts). A Section 129 notice is only issued once the
 *     email provider accepts it.
 *   - A LOAN_ADMIN collections manager. Write-off is dual control (requester ≠
 *     approver, both LOAN_ADMIN+), and the seed has one admin. It is bootstrapped
 *     with the stack (breadth/staff.ts), so an admin and it are two people from day one.
 *   - Settings → Attorneys (POST /api/settings/attorneys): the panel firm an
 *     account is handed to after a Section 129 notice.
 *   - Settings → Bank Statement Import (PATCH /api/settings/bank-sync, ADMIN
 *     with a TOTP-verified session): on, so the weekly statement goes through
 *     Payments → Bank reconciliation (servicing/bank-statement.ts).
 *
 * The collections manager's credentials are kept in scripts/demo/.sim-staff.json
 * (chmod 600, untracked), tagged with the user id so a fresh database is detected.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

import { demoLender } from "../../../prisma/demo-lender"
import { COLLECTIONS_MANAGER, COLLECTIONS_MANAGER_FILE } from "../breadth/staff"
import { ensureStaffSessions, type OriginationContext } from "../scenarios/context"
import { SimClient } from "../sim/api"
import type { StaffCredentials } from "../sim/credentials"
import { log } from "../sim/env"

const LENDER = demoLender()
export const SMTP_SINK_HOST = "credaflow-demo-sim-smtp"
export const ATTORNEY_FIRM = "Kroonstad Vale & Mokgosi Attorneys"

export interface Actors extends OriginationContext {
  /** LOAN_ADMIN collections manager: payouts, debit-order results, reversals, write-off requests. */
  loanAdmin: SimClient
  loanAdminCreds: StaffCredentials
}

interface StoredStaff extends StaffCredentials {
  userId: string
}

interface UserRow {
  id: string
  email: string
  role: string
}

/** The collections manager, bootstrapped with the stack (breadth/staff.ts says why it is not created through Settings → Users). */
async function ensureLoanAdmin(ctx: OriginationContext): Promise<StaffCredentials> {
  const users = (await ctx.admin.get<{ users: UserRow[] }>("/api/settings/users")).json?.users ?? []
  const existing = users.find((u) => u.email === COLLECTIONS_MANAGER.email)
  const stored = existsSync(COLLECTIONS_MANAGER_FILE) ? (JSON.parse(readFileSync(COLLECTIONS_MANAGER_FILE, "utf8")) as StoredStaff) : null
  if (!existing || stored?.userId !== existing.id) {
    throw new Error(`${COLLECTIONS_MANAGER.email} is not bootstrapped, or ${COLLECTIONS_MANAGER_FILE} does not hold its credentials; start from a fresh stack`)
  }
  return stored
}

async function ensureEmailConfig(ctx: OriginationContext): Promise<void> {
  const current = (await ctx.admin.get<{ smtpHost?: string | null; active?: boolean } | null>("/api/email/config")).json
  if (current?.smtpHost === SMTP_SINK_HOST && current.active) return
  await ctx.admin.post("/api/email/config", {
    provider: "IMAP_SMTP",
    fromName: LENDER.identity.brandName,
    fromAddress: `accounts@${LENDER.staffDomain}`,
    replyToAddress: `support@${LENDER.staffDomain}`,
    smtpHost: SMTP_SINK_HOST,
    smtpPort: 2525,
    smtpUser: `${LENDER.slug}-sim`,
    smtpPass: randomBytes(12).toString("base64url"),
    useTls: false,
    active: true,
  })
  log(`Settings → Email: SMTP ${SMTP_SINK_HOST}:2525`)
}

/** Turns outbound email off again (the sink exists only in the sim stack). */
export async function deactivateEmailConfig(ctx: OriginationContext): Promise<void> {
  const current = (await ctx.admin.get<Record<string, unknown> | null>("/api/email/config")).json
  if (!current || current.active === false) return
  // The masked secret is echoed back unchanged, as the settings form does.
  await ctx.admin.post("/api/email/config", { ...current, active: false })
  log("Settings → Email: deactivated for the snapshot")
}

async function ensureAttorneyFirm(ctx: OriginationContext): Promise<void> {
  const firms = (await ctx.admin.get<Array<{ name: string }>>("/api/settings/attorneys")).json ?? []
  if (firms.some((f) => f.name === ATTORNEY_FIRM)) return
  await ctx.admin.post("/api/settings/attorneys", {
    name: ATTORNEY_FIRM,
    contactPerson: "Adv. Pieter-Jan Mokgosi",
    phone: "011 555 0142",
    email: "collections@kroonstad-vale.invalid",
    address: "4th Floor, 18 Wierda Road, Sandton",
    specialisation: "NCA debt recovery",
  }, { expect: [200, 201] })
  log(`Settings → Attorneys: ${ATTORNEY_FIRM}`)
}

async function ensureBankSync(ctx: OriginationContext): Promise<void> {
  const current = (await ctx.admin.get<{ bankSyncEnabled: boolean }>("/api/settings/bank-sync")).json
  if (current?.bankSyncEnabled === true) return
  const res = await ctx.admin.patch<{ ok: boolean; bankSyncEnabled: boolean }>("/api/settings/bank-sync", { bankSyncEnabled: true })
  if (res.json?.bankSyncEnabled !== true) throw new Error(`PATCH /api/settings/bank-sync did not enable it: ${res.text.slice(0, 300)}`)
  log("Settings → Bank Statement Import: on")
}

export async function ensureServicingSetup(ctx: OriginationContext): Promise<Actors> {
  await ensureStaffSessions(ctx)
  await ensureEmailConfig(ctx)
  await ensureAttorneyFirm(ctx)
  await ensureBankSync(ctx)
  const loanAdminCreds = await ensureLoanAdmin(ctx)
  const loanAdmin = new SimClient()
  // The collections manager also pays out: the ADMIN approved, and under
  // segregation of duties the approver may not disburse.
  return { ...ctx, loanAdmin, loanAdminCreds, disburser: { client: loanAdmin, creds: loanAdminCreds } }
}

/** Staff sessions for every actor, re-signed only when expired. */
export async function ensureActorSessions(a: Actors): Promise<void> {
  await ensureStaffSessions(a)
  if (a.loanAdmin.user && (await a.loanAdmin.session())) return
  await a.loanAdmin.loginStaff(a.loanAdminCreds.email, a.loanAdminCreds.password, a.loanAdminCreds.totpSecret)
  log(`signed in LOAN_ADMIN ${a.loanAdminCreds.email}`)
}
