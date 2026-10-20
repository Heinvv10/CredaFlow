/**
 * Two synthetic dealers on the demo lender (slice 5 part A), written through
 * the staff dealer lib functions the routes call, so every guard trigger,
 * CHECK and audit row is the app's own:
 *
 *   Highveld Yellow Iron (Pty) Ltd   DEALER, VAT vendor, linked to the seeded
 *                                    supplier; a dealer admin and a sales user;
 *                                    its own rate 2.50% + R1 500
 *   Karoo Asset Brokers CC           BROKER, not a VAT vendor; a dealer admin;
 *                                    its own rate 1.75%
 *
 * plus the lender's default rate (1.00%), and for each dealer a bank account
 * requested by adminOne and approved by adminTwo (four eyes, manual
 * verification recorded). A user's password is set through its one-time link
 * (setDealerPassword); SEED_DEALER_PASSWORD sets (and on a rerun resets) every
 * dealer user's password, else one is generated when the user is created and
 * printed only with SEED_PRINT_CREDENTIALS=1. Dealer sign-in also needs the
 * lender's dealer portal switched on (Settings -> Asset Finance; demo lenders
 * only) and DEALER_APP_HOST. Every value is synthetic.
 *
 * Idempotent: each row is found by its natural key and written only if missing.
 */
import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { dbDate } from "@/lib/asset-finance/dates"
import { parseBankAccountRequest } from "@/lib/asset-finance/supplier-input"
import { createDealer, parseDealerInput } from "@/lib/dealer/staff-dealers"
import { setCommissionRate, type RateInput } from "@/lib/dealer/staff-rates"
import { decideDealerBankAccount, requestDealerBankAccount } from "@/lib/dealer/staff-bank-accounts"
import { createDealerUser } from "@/lib/dealer/users"
import { issueDealerPasswordLink, setDealerPassword } from "@/lib/dealer/password-links"
import type { StaffActor } from "@/lib/dealer/actor"
import type { DealerRole } from "@prisma/client"
import type { SeedStaff } from "./asset-finance-deal"
import { seedEnvPassword } from "./env-password"

const DEFAULT_RATE: RateInput = { effectiveFrom: "2026-01-01", bps: 100, flatCents: 0 }
const ACCOUNT_NOTE = "Not run: juristic AVS unsupported. Verified manually against the bank-stamped confirmation letter on file."

interface SeedDealer {
  dealer: Record<string, unknown>
  linkSupplier: boolean
  users: { email: string; name: string; role: DealerRole }[]
  rate: RateInput
  account: Record<string, unknown>
}

const DEALERS: SeedDealer[] = [
  {
    dealer: {
      name: "Highveld Yellow Iron (Pty) Ltd", kind: "DEALER", registrationNumber: "2099/000011/07", vatNumber: "4999999981",
      contactEmail: "sales@highveld-yellow-iron.invalid", contactPhone: "+27 11 000 0111",
    },
    linkSupplier: true,
    users: [
      { email: "admin@highveld-yellow-iron.invalid", name: "Pieter Demo-Admin", role: "DEALER_ADMIN" },
      { email: "sales@highveld-yellow-iron.invalid", name: "Thandi Demo-Sales", role: "DEALER_SALES" },
    ],
    rate: { effectiveFrom: "2026-01-01", bps: 250, flatCents: 150_000 },
    account: { bankName: "Highveld Merchant Bank", branchCode: "000099", accountNumber: "0000000111", accountHolder: "Highveld Yellow Iron (Pty) Ltd", accountType: "CHEQUE" },
  },
  {
    dealer: { name: "Karoo Asset Brokers CC", kind: "BROKER", registrationNumber: "2099/000012/23", contactEmail: "desk@karoo-asset-brokers.invalid" },
    linkSupplier: false,
    users: [{ email: "admin@karoo-asset-brokers.invalid", name: "Johan Demo-Broker", role: "DEALER_ADMIN" }],
    rate: { effectiveFrom: "2026-01-01", bps: 175, flatCents: 0 },
    account: { bankName: "Highveld Merchant Bank", branchCode: "000099", accountNumber: "0000000112", accountHolder: "Karoo Asset Brokers CC", accountType: "CHEQUE" },
  },
]

const generatedPassword = () => `Demo-${randomBytes(12).toString("base64url")}!`
const fail = (what: string, result: unknown): never => {
  throw new Error(`Seed: ${what} refused (${JSON.stringify(result)})`)
}

async function ensureRate(staff: StaffActor, dealerId: string | null, rate: RateInput): Promise<void> {
  const exists = await prisma.dealerCommissionRate.findFirst({
    where: { tenantId: staff.tenantId, dealerId, effectiveFrom: dbDate(rate.effectiveFrom) }, select: { id: true },
  })
  if (exists) return
  const result = await setCommissionRate(staff, dealerId, rate)
  if (result.kind !== "created") fail("commission rate", result)
}

async function ensureUser(staff: StaffActor, dealerId: string, user: SeedDealer["users"][number]): Promise<void> {
  const envPassword = seedEnvPassword("SEED_DEALER_PASSWORD")
  const existing = await prisma.dealerUser.findFirst({ where: { tenantId: staff.tenantId, email: user.email }, select: { id: true } })
  let token: string
  if (existing) {
    if (!envPassword) return
    const link = await issueDealerPasswordLink(staff, dealerId, existing.id)
    token = link.kind === "issued" ? link.token : fail("dealer password link", link)
  } else {
    const created = await createDealerUser({ kind: "staff", staff }, dealerId, user)
    token = created.kind === "created" ? created.token : fail("dealer user", created)
  }
  const password = envPassword ?? generatedPassword()
  const set = await setDealerPassword({ tenantId: staff.tenantId, token, password })
  if (set.kind !== "set") fail("dealer password", set)
  if (!envPassword && process.env.SEED_PRINT_CREDENTIALS === "1") process.stdout.write(`Dealer login ${user.email}: ${password}\n`)
}

async function ensureAccount(staff: SeedStaff, tenantId: string, dealerId: string, raw: Record<string, unknown>): Promise<void> {
  const parsed = parseBankAccountRequest(raw)
  if ("errors" in parsed) return fail("dealer bank account input", parsed.errors)
  const fields = parsed.data
  let account = await prisma.dealerBankAccount.findFirst({
    where: { tenantId, dealerId, status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, status: true },
  })
  if (!account) {
    const requester = { tenantId, userId: staff.adminOne.id, userEmail: staff.adminOne.email }
    const requested = await requestDealerBankAccount(requester, dealerId, fields)
    account = requested.kind === "requested" ? requested.account : fail("dealer bank account request", requested)
  }
  if (account.status !== "PENDING") return
  const accountId = account.id
  const decided = await prisma.$transaction((tx) => decideDealerBankAccount(tx, {
    tenantId, accountId, decision: "APPROVE", note: ACCOUNT_NOTE, decider: { id: staff.adminTwo.id, email: staff.adminTwo.email },
  }))
  if (decided.kind !== "decided") fail("dealer bank account approval", decided)
}

/** Runs inside seedAssetFinance's tenant scope, after the supplier is seeded. */
export async function seedDealers(tenantId: string, staff: SeedStaff, supplierId: string): Promise<void> {
  const admin: StaffActor = { tenantId, userId: staff.adminOne.id, userEmail: staff.adminOne.email }
  await ensureRate(admin, null, DEFAULT_RATE)
  for (const seed of DEALERS) {
    const parsed = parseDealerInput({ ...seed.dealer, ...(seed.linkSupplier ? { supplierId } : {}) }, false)
    if ("errors" in parsed) return fail("dealer input", parsed.errors)
    const input = parsed.data
    const found = await prisma.dealer.findFirst({ where: { tenantId, name: input.name }, select: { id: true } })
    let dealerId: string
    if (found) dealerId = found.id
    else {
      const created = await createDealer(admin, input)
      dealerId = created.kind === "created" ? created.dealerId : fail("dealer", created)
    }
    for (const user of seed.users) await ensureUser(admin, dealerId, user)
    await ensureRate(admin, dealerId, seed.rate)
    await ensureAccount(staff, tenantId, dealerId, seed.account)
  }
}
