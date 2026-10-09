import { randomInt, randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"

// Shared real-Postgres fixture for the bureau-submission integration tests.
// Synthetic people only: the ID numbers are generated and pass the check digit.

/** A random ID number that passes the Home Affairs check digit. */
export function syntheticSaId(): string {
  const two = (n: number) => String(n).padStart(2, "0")
  const body = `${two(randomInt(60, 99))}${two(randomInt(1, 13))}${two(randomInt(1, 29))}${String(randomInt(5000, 10000))}08`
  let sum = 0
  for (let i = 0; i < 12; i++) {
    let digit = Number(body[i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return `${body}${(10 - (sum % 10)) % 10}`
}

/** A 13-digit ID number whose check digit is wrong. */
export function invalidSaId(): string {
  const valid = syntheticSaId()
  return `${valid.slice(0, 12)}${(Number(valid[12]) + 1) % 10}`
}

export interface BureauTenant {
  tenantId: string
  userId: string
  products: { PERSONAL: string; MICRO: string; PO_FUNDING: string }
}

export async function createBureauTenant(
  db: PrismaClient,
  config: { featureBureauSubmission?: boolean; bureauSupplierNumber?: string | null; role?: "SUPER_ADMIN" | "LOAN_ADMIN" | "CREDIT_OFFICER" } = {},
): Promise<BureauTenant> {
  const t = randomUUID().replaceAll("-", "").slice(0, 16)
  const tenantId = `t_bur_${t}`
  const userId = `u_bur_${t}`
  await db.tenant.create({ data: { id: tenantId, slug: `bur-${t}`, name: "Bureau IT" } })
  await db.tenantConfig.create({
    data: {
      tenantId,
      featureBureauSubmission: config.featureBureauSubmission ?? true,
      bureauSupplierNumber: config.bureauSupplierNumber === undefined ? "TT0109" : config.bureauSupplierNumber,
      bureauTradingName: "Bureau IT Lender",
      bureauReportingStartDate: new Date("2026-06-01T00:00:00.000Z"),
    },
  })
  await db.user.create({
    data: { id: userId, tenantId, email: `${t}@test.invalid`, password: "x", role: config.role ?? "SUPER_ADMIN" },
  })
  const product = async (productType: "PERSONAL" | "MICRO" | "PO_FUNDING") => (await db.loanProduct.create({
    data: {
      tenantId, code: productType, name: productType, productType,
      minAmount: 1, maxAmount: 10_000_000, minTermDays: 1, maxTermDays: 365,
      interestRatePm: 0, interestModel: "FLAT",
    },
  })).id
  return {
    tenantId,
    userId,
    products: { PERSONAL: await product("PERSONAL"), MICRO: await product("MICRO"), PO_FUNDING: await product("PO_FUNDING") },
  }
}

export const INSTALMENT = 50_000
export const sast = (isoDay: string, time = "10:00:00") => new Date(`${isoDay}T${time}+02:00`)

/**
 * An interest-free loan of two R500 instalments. By default it starts on
 * 1 Jul 2026 with instalments due 1 Aug and 1 Sep.
 */
export async function createBureauLoan(db: PrismaClient, tenant: BureauTenant, opts: {
  productType?: "PERSONAL" | "MICRO" | "PO_FUNDING"
  startDay?: string
  dueDays?: [string, string]
  idNumber?: string
  lastName?: string
} = {}) {
  const n = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()
  const dueDays = opts.dueDays ?? ["2026-08-01", "2026-09-01"]
  const client = await db.client.create({
    data: {
      tenantId: tenant.tenantId, idNumber: opts.idNumber ?? syntheticSaId(), firstName: "Bureau",
      lastName: opts.lastName ?? "Fixture", email: `${n}@client.invalid`, phone: "0820000000",
    },
  })
  const productId = tenant.products[opts.productType ?? "PERSONAL"]
  const app = await db.loanApplication.create({
    data: {
      tenantId: tenant.tenantId, reference: `APP-${n}`, clientId: client.id, productId,
      appliedAmount: 2 * INSTALMENT, appliedTermDays: 61,
    },
  })
  const loan = await db.loan.create({
    data: {
      tenantId: tenant.tenantId, reference: `LN-${n}`, applicationId: app.id, clientId: client.id,
      productId, principal: 2 * INSTALMENT, totalInterest: 0, initiationFee: 0,
      totalRepayable: 2 * INSTALMENT, outstandingPrincipal: 2 * INSTALMENT,
      startDate: sast(opts.startDay ?? "2026-07-01"), maturityDate: sast(dueDays[1]),
      interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE",
      repaymentSchedule: {
        create: dueDays.map((day, i) => ({
          tenantId: tenant.tenantId, installmentNo: i + 1, dueDate: sast(day),
          principalDue: INSTALMENT, interestDue: 0, feesDue: 0, totalDue: INSTALMENT,
        })),
      },
    },
  })
  return { loanId: loan.id, reference: loan.reference, clientId: client.id }
}
