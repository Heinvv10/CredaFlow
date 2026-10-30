/**
 * Real-Postgres proof that the cross-sell and dormant-clients crons sweep
 * EVERY tenant, not just the deployment's default: with two real lenders each
 * route creates opportunities for the clients of both, and each opportunity's
 * tenantId equals its client's tenantId.
 *
 * A SUSPENDED tenant is not swept: both crons create sales opportunities.
 *
 * Nothing is stubbed: the Prisma tenant-scope extension and the cron secret
 * check are the real ones.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/cron/tenant-sweep.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { POST as crossSell } from "@/app/api/cron/cross-sell/route"
import { POST as dormantClients } from "@/app/api/cron/dormant-clients/route"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
// Fixtures and assertions read through a plain client, so they see the
// database rather than what the extension lets through.
const db = new PrismaClient()

const DAY_MS = 86_400_000
const CRON_SECRET = "tenant-sweep-it-cron-secret"

interface Lender {
  tenantId: string
  dormantClientId: string
  activeClientId: string
  creditLifeClientId: string
}

// Every tenant this suite creates, recorded as soon as it exists so a
// fixture that fails half-way is still cleaned up.
const createdTenantIds: string[] = []

async function client(tenantId: string, token: string, label: string) {
  return db.client.create({
    data: {
      tenantId, idNumber: `91${randomBytes(5).toString("hex")}`, firstName: "Synthetic", lastName: label,
      email: `${label}-${token}@tenant-sweep-it.invalid`, phone: "0820000000",
    },
  })
}

async function lender(label: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE"): Promise<Lender> {
  const token = randomBytes(6).toString("hex")
  const tenant = await db.tenant.create({
    data: { slug: `sweep-it-${label}-${token}`, name: `Tenant Sweep IT ${label}`, status },
  })
  const tenantId = tenant.id
  createdTenantIds.push(tenantId)

  // No loans and no CRM activity: dormant-clients flags it.
  const dormant = await client(tenantId, token, "dormant")
  // No loans but a CRM note yesterday: dormant-clients leaves it alone.
  const active = await client(tenantId, token, "active")
  await db.crmActivity.create({
    data: {
      tenantId, clientId: active.id, type: "NOTE", subject: "Synthetic note", createdById: "synthetic-user",
      createdAt: new Date(Date.now() - DAY_MS),
    },
  })

  // An ACTIVE PERSONAL loan over R20 000 and no credit life: cross-sell rule 2.
  const creditLife = await client(tenantId, token, "creditlife")
  const product = await db.loanProduct.create({
    data: {
      tenantId, code: `TSIT-${token}`, name: "Synthetic Personal", productType: "PERSONAL",
      minAmount: 1, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365,
      interestRatePm: 0, interestModel: "FLAT",
    },
  })
  const app = await db.loanApplication.create({
    data: {
      tenantId, reference: `TSIT-APP-${token}`, clientId: creditLife.id, productId: product.id,
      appliedAmount: 3_000_000, appliedTermDays: 180,
    },
  })
  await db.loan.create({
    data: {
      tenantId, reference: `TSIT-LN-${token}`, applicationId: app.id, clientId: creditLife.id,
      productId: product.id, principal: 3_000_000, totalInterest: 0, initiationFee: 0,
      totalRepayable: 3_000_000, outstandingPrincipal: 3_000_000,
      startDate: new Date(Date.now() - 30 * DAY_MS), maturityDate: new Date(Date.now() + 150 * DAY_MS),
      interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE",
    },
  })
  return { tenantId, dormantClientId: dormant.id, activeClientId: active.id, creditLifeClientId: creditLife.id }
}

const cronRequest = (path: string) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "x-cron-secret": CRON_SECRET },
})

/** The opportunities for these clients, with the tenant each client belongs to. */
async function opportunities(clientIds: string[]) {
  const rows = await db.crossSellOpportunity.findMany({
    where: { clientId: { in: clientIds } },
    select: { clientId: true, tenantId: true, type: true, status: true, client: { select: { tenantId: true } } },
  })
  return rows.map((r) => ({ clientId: r.clientId, tenantId: r.tenantId, clientTenantId: r.client.tenantId, type: r.type, status: r.status }))
}

type SweepEntry = { tenantId: string; error?: string }

/**
 * This suite's own tenants' perTenant entries. The overall status is not
 * asserted: the sweep covers every ACTIVE tenant in the shared database, so a
 * failure in another suite's tenant makes it 503 without being this suite's
 * concern.
 */
function ownEntries(perTenant: SweepEntry[], tenantIds: string[]): SweepEntry[] {
  return perTenant.filter((t) => tenantIds.includes(t.tenantId))
}

const SWEEP_TIMEOUT_MS = 30_000

suite.sequential("cross-sell and dormant-clients sweep every ACTIVE tenant (real Postgres)", () => {
  let a: Lender
  let b: Lender
  let suspended: Lender
  const savedCronSecret = process.env.CRON_SECRET

  beforeAll(async () => {
    a = await lender("a")
    b = await lender("b")
    suspended = await lender("s", "SUSPENDED")
    process.env.CRON_SECRET = CRON_SECRET
  })
  afterAll(async () => {
    if (savedCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = savedCronSecret

    // Children before parents. `db` has no tenant-scope extension, so no
    // frame is needed. Other suites' tenants are never touched.
    const tenantId = { in: createdTenantIds }
    await purgeAuditRowsForTest(db, { tenantId })
    await db.crossSellOpportunity.deleteMany({ where: { tenantId } })
    await db.crmActivity.deleteMany({ where: { tenantId } })
    await db.loan.deleteMany({ where: { tenantId } })
    await db.loanApplication.deleteMany({ where: { tenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId } })
    await db.client.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("cross-sell creates a CREDIT_LIFE opportunity for the client of EACH tenant, under that client's tenant", async () => {
    const response = await crossSell(cronRequest("/api/cron/cross-sell"))
    // Other suites' rows share this database and the cron sweeps every
    // tenant, so the totals are lower bounds; the rows below are this suite's own.
    const body = await response.json() as { created: number; perTenant: SweepEntry[] }
    expect(body.created).toBeGreaterThanOrEqual(2)
    expect(ownEntries(body.perTenant, [a.tenantId, b.tenantId]).map(({ tenantId, error }) => ({ tenantId, error })))
      .toEqual([a.tenantId, b.tenantId].map((tenantId) => ({ tenantId, error: undefined })))

    expect(await opportunities([a.creditLifeClientId, b.creditLifeClientId])).toEqual(expect.arrayContaining([
      { clientId: a.creditLifeClientId, tenantId: a.tenantId, clientTenantId: a.tenantId, type: "CREDIT_LIFE", status: "PENDING" },
      { clientId: b.creditLifeClientId, tenantId: b.tenantId, clientTenantId: b.tenantId, type: "CREDIT_LIFE", status: "PENDING" },
    ]))
    expect(await opportunities([a.creditLifeClientId, b.creditLifeClientId])).toHaveLength(2)
    expect(ownEntries(body.perTenant, [suspended.tenantId])).toEqual([])
    expect(await opportunities([suspended.creditLifeClientId])).toEqual([])

    // A second run finds each tenant's open opportunity through its own
    // tenant-scoped duplicate check and creates nothing for these clients.
    await crossSell(cronRequest("/api/cron/cross-sell"))
    expect(await opportunities([a.creditLifeClientId, b.creditLifeClientId])).toHaveLength(2)
  }, SWEEP_TIMEOUT_MS)

  it("dormant-clients flags the dormant client of EACH tenant, under that client's tenant, and leaves the recently active ones", async () => {
    const response = await dormantClients(cronRequest("/api/cron/dormant-clients"))
    const body = await response.json() as { flagged: number; perTenant: SweepEntry[] }
    expect(body.flagged).toBeGreaterThanOrEqual(2)
    expect(ownEntries(body.perTenant, [a.tenantId, b.tenantId]).map(({ tenantId, error }) => ({ tenantId, error })))
      .toEqual([a.tenantId, b.tenantId].map((tenantId) => ({ tenantId, error: undefined })))

    expect(await opportunities([a.dormantClientId, a.activeClientId, b.dormantClientId, b.activeClientId])).toEqual(expect.arrayContaining([
      { clientId: a.dormantClientId, tenantId: a.tenantId, clientTenantId: a.tenantId, type: "PERSONAL_LOAN", status: "PENDING" },
      { clientId: b.dormantClientId, tenantId: b.tenantId, clientTenantId: b.tenantId, type: "PERSONAL_LOAN", status: "PENDING" },
    ]))
    expect(await opportunities([a.dormantClientId, a.activeClientId, b.dormantClientId, b.activeClientId])).toHaveLength(2)
    expect(ownEntries(body.perTenant, [suspended.tenantId])).toEqual([])
    expect(await opportunities([suspended.dormantClientId])).toEqual([])

    // A second run finds the open opportunity and creates nothing for these clients.
    await dormantClients(cronRequest("/api/cron/dormant-clients"))
    expect(await opportunities([a.dormantClientId, b.dormantClientId])).toHaveLength(2)
  }, SWEEP_TIMEOUT_MS)
})
