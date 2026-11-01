/**
 * The bake's extra staff, bootstrapped beside the seed (sim/provision-operator.ts --staff) with the operator, so
 * they carry the seed's exemption from the two-people rule (lib/security/account-control.ts) and a baked admin and
 * baked staff member can sit a two-person control on day one. Created through Settings → Users they would not:
 * the admin's USER_CREATED row would keep them apart for 30 days. Likewise the operator, not the admin, assigns their
 * branches and inbox roster (breadth/setup.ts). The staff are:
 *
 *   - a second credit officer at the Pretoria branch (half the originations,
 *     CRM leads);
 *   - an insurance officer, the FAIS representative (quotes, advice, binding,
 *     claims);
 *   - the Pretoria branch manager (complaints, TCF, referral commissions);
 *   - a platform operator (SUPER_ADMIN). The CRM and bureau-submission modules
 *     are switched on per tenant only through the operator API
 *     (/api/admin/tenants, SUPER_ADMIN + x-admin-secret). Settings → Users
 *     refuses to create a role above the caller's, and no route creates a
 *     SUPER_ADMIN, so sim/provision-operator.ts bootstraps this account when
 *     the stack is seeded (sim/fresh-stack.sh); it is not created here.
 *
 * Credentials are generated here (the operator's by provision-operator.ts) and
 * kept in scripts/demo/.sim-breadth-staff.json (chmod 600, untracked), keyed by
 * email and tagged with the user id so a fresh database is detected.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { demoLender, type DemoLender } from "../../../prisma/demo-lender"
import { SimClient } from "../sim/api"
import type { StaffCredentials } from "../sim/credentials"
import { SIM_CREDENTIALS_FILE, log } from "../sim/env"

const FILE = path.join(path.dirname(SIM_CREDENTIALS_FILE), ".sim-breadth-staff.json")

export type StaffKey = "officer2" | "insurance" | "branchManager" | "operator"

interface StaffSpec {
  name: string
  email: string
  role: "CREDIT_OFFICER" | "INSURANCE_OFFICER" | "BRANCH_MANAGER" | "SUPER_ADMIN"
  phone?: string
  /** Branch code (breadth/setup.ts BRANCHES). */
  branch?: string
}

/** The lender's staff are on its staff domain; the platform operator is not lender staff. */
export function staffFor(lender: DemoLender): Readonly<Record<StaffKey, StaffSpec>> {
  const d = lender.staffDomain
  return {
    officer2: { name: "Lindiwe Mahlangu", email: `lindiwe.mahlangu@${d}`, role: "CREDIT_OFFICER", phone: "+27120000101", branch: "PTA" },
    insurance: { name: "Priya Govender", email: `priya.govender@${d}`, role: "INSURANCE_OFFICER", phone: "+27110000102", branch: "SAN" },
    branchManager: { name: "Pieter Steyn", email: `pieter.steyn@${d}`, role: "BRANCH_MANAGER", phone: "+27120000103", branch: "PTA" },
    operator: { name: "CredaFlow Platform Operator", email: "operator@credaflow-platform.example", role: "SUPER_ADMIN" },
  }
}

export const STAFF = staffFor(demoLender())

/** The collections manager (servicing/setup.ts): payouts, debit-order results, reversals, write-off requests. */
export const COLLECTIONS_MANAGER = { name: "Nomsa Khumalo-Reddy", email: `collections.manager@${demoLender().staffDomain}`, role: "LOAN_ADMIN" } as const
/** Everyone sim/operator.ts provisionBakeStaff bootstraps. */
export const BAKE_STAFF = [STAFF.officer2, STAFF.insurance, STAFF.branchManager, COLLECTIONS_MANAGER] as const
export const COLLECTIONS_MANAGER_FILE = path.join(path.dirname(SIM_CREDENTIALS_FILE), ".sim-staff.json")

export interface StoredStaff extends StaffCredentials {
  userId: string
}

export interface StaffMember {
  creds: StoredStaff
  client: SimClient
}

export type BreadthStaff = Record<StaffKey, StaffMember>

type Stored = Partial<Record<string, StoredStaff>>

const readStored = (): Stored => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Stored) : {})

/** Records (or replaces) one member's credentials in the credentials file. */
export function storeStaffCredentials(creds: StoredStaff): void {
  const stored = readStored()
  stored[creds.email] = creds
  writeFileSync(FILE, JSON.stringify(stored, null, 2), { mode: 0o600 })
}

interface UserRow {
  id: string
  email: string
}

/** Returns every breadth staff member, bootstrapped by sim/fresh-stack.sh (branches are assigned by breadth/setup.ts). */
export async function ensureBreadthStaff(admin: SimClient): Promise<BreadthStaff> {
  const users = (await admin.get<{ users: UserRow[] }>("/api/settings/users")).json?.users ?? []
  const stored = readStored()
  const out: Partial<BreadthStaff> = {}
  for (const key of Object.keys(STAFF) as StaffKey[]) {
    const spec = STAFF[key]
    const existing = users.find((u) => u.email === spec.email)
    const creds = stored[spec.email]
    if (!existing) throw new Error(`no ${spec.email}; sim/fresh-stack.sh provisions it (sim/provision-operator.ts)`)
    if (creds?.userId !== existing.id) throw new Error(`${spec.email} exists but ${FILE} does not hold its credentials; start from a fresh stack`)
    out[key] = { creds, client: new SimClient() }
  }
  return out as BreadthStaff
}

/** Breadth staff from the credentials file alone (a resumed bake, after setup ran). */
export function loadBreadthStaff(): BreadthStaff | null {
  const stored = readStored()
  const out: Partial<BreadthStaff> = {}
  for (const key of Object.keys(STAFF) as StaffKey[]) {
    const creds = stored[STAFF[key].email]
    if (!creds) return null
    out[key] = { creds, client: new SimClient() }
  }
  return out as BreadthStaff
}

/** A signed-in client for `member`, re-signed only when its session has expired. */
export async function signedIn(member: StaffMember): Promise<SimClient> {
  if (member.client.user && (await member.client.session())) return member.client
  await member.client.loginStaff(member.creds.email, member.creds.password, member.creds.totpSecret)
  log(`signed in ${member.client.user?.role} ${member.creds.email}`)
  return member.client
}
