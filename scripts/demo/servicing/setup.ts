/**
 * Lender configuration the servicing storylines need, done through Settings
 * the way a lender's admin would before collecting (all ADMIN, all idempotent):
 *
 *   - Settings → Email (POST /api/email/config): SMTP pointed at the sim's
 *     sink (sim/smtp-sink.ts). A Section 129 notice is only issued once the
 *     email provider accepts it.
 *   - Settings → Users (POST /api/settings/users): a LOAN_ADMIN collections
 *     manager. Write-off is dual control (requester ≠ approver, both
 *     LOAN_ADMIN+), and the seed has one admin. The new user enrols TOTP
 *     (GET/POST /api/settings/totp) on first sign-in, as the UI forces.
 *   - Settings → Attorneys (POST /api/settings/attorneys): the panel firm an
 *     account is handed to after a Section 129 notice.
 *   - Settings → Bank Statement Import (PATCH /api/settings/bank-sync, ADMIN
 *     with a TOTP-verified session): on, so the weekly statement goes through
 *     Payments → Bank reconciliation (servicing/bank-statement.ts).
 *
 * The collections manager's credentials are generated here and kept in
 * scripts/demo/.sim-staff.json (chmod 600, untracked), tagged with the user
 * id so a fresh database is detected.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { generateTotpCode } from "../../../lib/totp"
import { ensureStaffSessions, type OriginationContext } from "../scenarios/context"
import { SimClient } from "../sim/api"
import { appNow } from "../sim/clock"
import type { StaffCredentials } from "../sim/credentials"
import { SIM_CREDENTIALS_FILE, log } from "../sim/env"

const STAFF_FILE = path.join(path.dirname(SIM_CREDENTIALS_FILE), ".sim-staff.json")
const LOAN_ADMIN_EMAIL = "collections.manager@acme-lending.example"
export const SMTP_SINK_HOST = "credaflow-demo-sim-smtp"
export const ATTORNEY_FIRM = "Kroonstad Vale & Mokgosi Attorneys"

export interface Actors extends OriginationContext {
  /** LOAN_ADMIN collections manager: debit-order results, reversals, write-off requests. */
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

async function ensureLoanAdmin(ctx: OriginationContext): Promise<StaffCredentials> {
  const users = (await ctx.admin.get<{ users: UserRow[] }>("/api/settings/users")).json?.users ?? []
  const existing = users.find((u) => u.email === LOAN_ADMIN_EMAIL)
  if (existing) {
    const stored = existsSync(STAFF_FILE) ? (JSON.parse(readFileSync(STAFF_FILE, "utf8")) as StoredStaff) : null
    if (stored?.userId !== existing.id) {
      throw new Error(`${LOAN_ADMIN_EMAIL} exists but ${STAFF_FILE} does not hold its credentials; start from a fresh stack`)
    }
    return stored
  }

  const password = randomBytes(18).toString("base64url")
  const created = await ctx.admin.post<UserRow>("/api/settings/users", {
    name: "Nomsa Khumalo-Reddy",
    email: LOAN_ADMIN_EMAIL,
    role: "LOAN_ADMIN",
    password,
  }, { expect: [201] })
  const userId = created.json?.id
  if (!userId) throw new Error(`user create returned no id: ${created.text.slice(0, 300)}`)

  const first = new SimClient()
  await first.loginStaffForEnrolment(LOAN_ADMIN_EMAIL, password)
  const enrol = (await first.get<{ secret: string }>("/api/settings/totp")).json
  if (!enrol?.secret) throw new Error("GET /api/settings/totp returned no secret")
  const code = generateTotpCode(enrol.secret, (await appNow()).getTime())
  await first.post("/api/settings/totp", { secret: enrol.secret, code })

  const stored: StoredStaff = { userId, email: LOAN_ADMIN_EMAIL, password, totpSecret: enrol.secret }
  writeFileSync(STAFF_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 })
  log(`collections manager ${LOAN_ADMIN_EMAIL} created (LOAN_ADMIN) and enrolled in TOTP`)
  return stored
}

async function ensureEmailConfig(ctx: OriginationContext): Promise<void> {
  const current = (await ctx.admin.get<{ smtpHost?: string | null; active?: boolean } | null>("/api/email/config")).json
  if (current?.smtpHost === SMTP_SINK_HOST && current.active) return
  await ctx.admin.post("/api/email/config", {
    provider: "IMAP_SMTP",
    fromName: "Acme Lending",
    fromAddress: "accounts@acme-lending.example",
    replyToAddress: "support@acme-lending.example",
    smtpHost: SMTP_SINK_HOST,
    smtpPort: 2525,
    smtpUser: "acme-sim",
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
  return { ...ctx, loanAdmin: new SimClient(), loanAdminCreds }
}

/** Staff sessions for every actor, re-signed only when expired. */
export async function ensureActorSessions(a: Actors): Promise<void> {
  await ensureStaffSessions(a)
  if (a.loanAdmin.user && (await a.loanAdmin.session())) return
  await a.loanAdmin.loginStaff(a.loanAdminCreds.email, a.loanAdminCreds.password, a.loanAdminCreds.totpSecret)
  log(`signed in LOAN_ADMIN ${a.loanAdminCreds.email}`)
}
