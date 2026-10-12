/**
 * The bake's extra staff, created the way a lender's admin adds people
 * (Settings → Users, POST /api/settings/users) and each enrolled in TOTP on
 * first sign-in (GET/POST /api/settings/totp), as the UI forces:
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
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { generateTotpCode } from "../../../lib/totp"
import { SimClient } from "../sim/api"
import { appNow } from "../sim/clock"
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

export const STAFF: Readonly<Record<StaffKey, StaffSpec>> = {
  officer2: { name: "Lindiwe Mahlangu", email: "lindiwe.mahlangu@acme-lending.example", role: "CREDIT_OFFICER", phone: "+27120000101", branch: "PTA" },
  insurance: { name: "Priya Govender", email: "priya.govender@acme-lending.example", role: "INSURANCE_OFFICER", phone: "+27110000102", branch: "SAN" },
  branchManager: { name: "Pieter Steyn", email: "pieter.steyn@acme-lending.example", role: "BRANCH_MANAGER", phone: "+27120000103", branch: "PTA" },
  operator: { name: "CredaFlow Platform Operator", email: "operator@credaflow-platform.example", role: "SUPER_ADMIN" },
}

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

async function createAndEnrol(admin: SimClient, spec: StaffSpec): Promise<StoredStaff> {
  const password = randomBytes(18).toString("base64url")
  const created = await admin.post<UserRow>("/api/settings/users", {
    name: spec.name, email: spec.email, role: spec.role, password, phone: spec.phone,
  }, { expect: [201] })
  const userId = created.json?.id
  if (!userId) throw new Error(`user create returned no id: ${created.text.slice(0, 300)}`)

  const first = new SimClient()
  await first.loginStaffForEnrolment(spec.email, password)
  const enrol = (await first.get<{ secret: string }>("/api/settings/totp")).json
  if (!enrol?.secret) throw new Error("GET /api/settings/totp returned no secret")
  await first.post("/api/settings/totp", { secret: enrol.secret, code: generateTotpCode(enrol.secret, (await appNow()).getTime()) })
  log(`staff ${spec.email} created (${spec.role}) and enrolled in TOTP`)
  return { userId, email: spec.email, password, totpSecret: enrol.secret }
}

/** Creates (once) and returns every breadth staff member (branches are assigned by breadth/setup.ts). */
export async function ensureBreadthStaff(admin: SimClient): Promise<BreadthStaff> {
  const users = (await admin.get<{ users: UserRow[] }>("/api/settings/users")).json?.users ?? []
  const stored = readStored()
  const out: Partial<BreadthStaff> = {}
  for (const key of Object.keys(STAFF) as StaffKey[]) {
    const spec = STAFF[key]
    const existing = users.find((u) => u.email === spec.email)
    let creds = stored[spec.email]
    if (existing) {
      if (creds?.userId !== existing.id) throw new Error(`${spec.email} exists but ${FILE} does not hold its credentials; start from a fresh stack`)
    } else if (key === "operator") {
      throw new Error(`no platform operator ${spec.email}; sim/fresh-stack.sh provisions it (sim/provision-operator.ts)`)
    } else {
      creds = await createAndEnrol(admin, spec)
      storeStaffCredentials(creds)
    }
    if (!creds) throw new Error(`no credentials for ${spec.email}`)
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
