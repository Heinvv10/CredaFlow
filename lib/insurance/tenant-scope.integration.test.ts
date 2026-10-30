/**
 * Real-Postgres proof that the insurance book and cross-sell opportunities are
 * tenant-scope models: a query on InsurancePolicy, InsuranceClaim,
 * PremiumPayment or CrossSellOpportunity with neither a tenant frame nor a
 * tenantId throws, and the two crons that read them outside a frame
 * (insurance-renewal, cross-sell) touch each tenant's rows only as that
 * tenant's.
 *
 * Nothing is stubbed: the Prisma tenant-scope extension and the cron secret
 * check are the real ones.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/tenant-scope.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant, TenantScopeError } from "@/lib/tenant-scope"
import { POST as insuranceRenewal } from "@/app/api/cron/insurance-renewal/route"
import { POST as crossSell } from "@/app/api/cron/cross-sell/route"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
// Fixtures and assertions read through a plain client, so they see the
// database rather than what the extension lets through.
const db = new PrismaClient()

const DAY_MS = 86_400_000
const CRON_SECRET = "insurance-scope-it-cron-secret"

interface Lender {
  tenantId: string
  slug: string
  clientId: string
  lapsingPolicyId: string
  renewingPolicyId: string
  claimId: string
  opportunityId: string
}

// Every tenant this suite creates, recorded as soon as it exists so a
// fixture that fails half-way is still cleaned up.
const createdTenantIds: string[] = []

async function lender(label: string): Promise<Lender> {
  const token = randomBytes(6).toString("hex")
  const slug = `ins-scope-it-${label}-${token}`
  const tenant = await db.tenant.create({ data: { slug, name: `Insurance Scope IT ${label}`, status: "ACTIVE" } })
  const tenantId = tenant.id
  createdTenantIds.push(tenantId)
  const client = await db.client.create({
    data: {
      tenantId, idNumber: `90${token}0`, firstName: "Synthetic", lastName: label.toUpperCase(),
      email: `${token}@ins-scope-it.invalid`, phone: "0820000000",
    },
  })
  const now = Date.now()
  const policy = (kind: string, renewalDate: Date) => db.insurancePolicy.create({
    data: {
      tenantId, clientId: client.id, policyNumber: `ISIT-${kind}-${token}`, type: "FUNERAL_COVER", status: "ACTIVE",
      premiumAmount: "83.00", sumAssured: "20000.00",
      startDate: new Date(now - 120 * DAY_MS), renewalDate,
      policySource: "STANDALONE", faisDisclosureAt: new Date(now - 120 * DAY_MS),
      faisDisclosurePdfUrl: `/synthetic/${kind}-${token}.pdf`,
    },
  })
  // Lapse-eligible: a premium OVERDUE beyond the 30-day grace; renews in a year.
  const lapsing = await policy("lapse", new Date(now + 365 * DAY_MS))
  await db.premiumPayment.create({
    data: { tenantId, policyId: lapsing.id, amount: "83.00", dueDate: new Date(now - 60 * DAY_MS), status: "OVERDUE" },
  })
  // Renewal-due: renews in ten days, nothing overdue.
  const renewing = await policy("renew", new Date(now + 10 * DAY_MS))
  const claim = await db.insuranceClaim.create({
    data: { tenantId, policyId: renewing.id, claimNumber: `ISIT-CLM-${token}`, claimAmount: "1000.00" },
  })
  const opportunity = await db.crossSellOpportunity.create({
    data: { tenantId, clientId: client.id, type: "FUNERAL_COVER", status: "PENDING" },
  })
  return {
    tenantId, slug, clientId: client.id, lapsingPolicyId: lapsing.id, renewingPolicyId: renewing.id,
    claimId: claim.id, opportunityId: opportunity.id,
  }
}

/** An ACTIVE PERSONAL loan over R20 000 and no credit life: cross-sell rule 2. */
async function creditLifeCandidate(l: Lender) {
  const n = randomBytes(6).toString("hex")
  const product = await db.loanProduct.create({
    data: {
      tenantId: l.tenantId, code: `ISIT-${n}`, name: "Synthetic Personal", productType: "PERSONAL",
      minAmount: 1, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365,
      interestRatePm: 0, interestModel: "FLAT",
    },
  })
  const app = await db.loanApplication.create({
    data: {
      tenantId: l.tenantId, reference: `ISIT-APP-${n}`, clientId: l.clientId, productId: product.id,
      appliedAmount: 3_000_000, appliedTermDays: 180,
    },
  })
  await db.loan.create({
    data: {
      tenantId: l.tenantId, reference: `ISIT-LN-${n}`, applicationId: app.id, clientId: l.clientId,
      productId: product.id, principal: 3_000_000, totalInterest: 0, initiationFee: 0,
      totalRepayable: 3_000_000, outstandingPrincipal: 3_000_000,
      startDate: new Date(Date.now() - 30 * DAY_MS), maturityDate: new Date(Date.now() + 150 * DAY_MS),
      interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE",
    },
  })
}

const cronRequest = (path: string) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "x-cron-secret": CRON_SECRET },
})

// A Prisma query starts when it is awaited, so it is awaited inside the frame.
const inTenant = <T>(l: Lender, query: () => PromiseLike<T>) => runWithTenant(l.tenantId, async () => await query())

suite.sequential("insurance and cross-sell models are tenant-scoped (real Postgres)", () => {
  let a: Lender
  let b: Lender
  const savedEnv = { cron: process.env.CRON_SECRET }

  beforeAll(async () => {
    a = await lender("a")
    b = await lender("b")
    process.env.CRON_SECRET = CRON_SECRET
  })
  afterAll(async () => {
    if (savedEnv.cron === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = savedEnv.cron

    // Everything this suite created, and everything the crons wrote for it,
    // belongs to its two tenants. Children before parents. `db` has no
    // tenant-scope extension, so no frame is needed.
    const tenantId = { in: createdTenantIds }
    await purgeAuditRowsForTest(db, { tenantId })
    await db.crmActivity.deleteMany({ where: { tenantId } })
    await db.notificationLog.deleteMany({ where: { tenantId } })
    await db.crossSellOpportunity.deleteMany({ where: { tenantId } })
    await db.insuranceClaim.deleteMany({ where: { tenantId } })
    await db.premiumPayment.deleteMany({ where: { tenantId } })
    await db.insurancePolicy.deleteMany({ where: { tenantId } })
    await db.loan.deleteMany({ where: { tenantId } })
    await db.loanApplication.deleteMany({ where: { tenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId } })
    await db.client.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  describe("a query with neither a frame nor a tenantId throws", () => {
    const delegates = {
      InsurancePolicy: () => prisma.insurancePolicy,
      InsuranceClaim: () => prisma.insuranceClaim,
      PremiumPayment: () => prisma.premiumPayment,
      CrossSellOpportunity: () => prisma.crossSellOpportunity,
    }

    it.each(Object.keys(delegates) as Array<keyof typeof delegates>)("%s.findMany", async (model) => {
      const delegate = delegates[model]() as unknown as { findMany: (args?: object) => Promise<unknown> }
      await expect(delegate.findMany()).rejects.toMatchObject({ name: "TenantScopeError", reason: "missing-context", model })
    })

    it.each(Object.keys(delegates) as Array<keyof typeof delegates>)("%s.count", async (model) => {
      const delegate = delegates[model]() as unknown as { count: (args?: object) => Promise<unknown> }
      await expect(delegate.count()).rejects.toMatchObject({ name: "TenantScopeError", reason: "missing-context", model })
    })

    it("an update by id alone, which would otherwise write another lender's row", async () => {
      await expect(prisma.insurancePolicy.update({ where: { id: b.lapsingPolicyId }, data: { status: "CANCELLED" } }))
        .rejects.toBeInstanceOf(TenantScopeError)
      await expect(prisma.crossSellOpportunity.updateMany({ where: { id: b.opportunityId }, data: { status: "CONTACTED" } }))
        .rejects.toBeInstanceOf(TenantScopeError)
      expect((await db.insurancePolicy.findUniqueOrThrow({ where: { id: b.lapsingPolicyId } })).status).toBe("ACTIVE")
      expect((await db.crossSellOpportunity.findUniqueOrThrow({ where: { id: b.opportunityId } })).status).toBe("PENDING")
    })

    it("a create without a tenantId", async () => {
      await expect(prisma.crossSellOpportunity.create({
        data: { client: { connect: { id: a.clientId } }, tenant: { connect: { id: a.tenantId } }, type: "CREDIT_LIFE" },
      })).rejects.toMatchObject({ name: "TenantScopeError", reason: "missing-context" })
    })
  })

  it("a tenant frame sees only its own rows, and refuses a tenantId naming another lender", async () => {
    const ids = await inTenant(a, async () => ({
      policies: (await prisma.insurancePolicy.findMany({ where: { id: { in: [a.lapsingPolicyId, b.lapsingPolicyId] } } })).map((r) => r.id),
      claims: (await prisma.insuranceClaim.findMany({ where: { id: { in: [a.claimId, b.claimId] } } })).map((r) => r.id),
      premiums: (await prisma.premiumPayment.findMany({ where: { policyId: { in: [a.lapsingPolicyId, b.lapsingPolicyId] } } })).map((r) => r.policyId),
      opportunities: (await prisma.crossSellOpportunity.findMany({ where: { id: { in: [a.opportunityId, b.opportunityId] } } })).map((r) => r.id),
    }))
    expect(ids).toEqual({
      policies: [a.lapsingPolicyId],
      claims: [a.claimId],
      premiums: [a.lapsingPolicyId],
      opportunities: [a.opportunityId],
    })
    await expect(inTenant(a, () => prisma.insuranceClaim.findMany({ where: { tenantId: b.tenantId } })))
      .rejects.toMatchObject({ reason: "cross-tenant-mismatch" })
  })

  it("insurance-renewal lapses and flags each tenant's policies under that tenant only", async () => {
    const response = await insuranceRenewal(cronRequest("/api/cron/insurance-renewal"))
    // Other suites' rows share this database and the cron sweeps every
    // tenant, so the totals are lower bounds; the rows below are this suite's own.
    expect(response.status).toBe(200)
    const body = await response.json() as { lapsed: number; renewed: number }
    expect(body.lapsed).toBeGreaterThanOrEqual(2)
    expect(body.renewed).toBeGreaterThanOrEqual(2)

    for (const l of [a, b]) {
      const lapsed = await db.insurancePolicy.findUniqueOrThrow({ where: { id: l.lapsingPolicyId } })
      expect(lapsed).toMatchObject({ tenantId: l.tenantId, status: "LAPSED" })
      expect(await db.auditLog.findMany({ where: { action: "POLICY_LAPSED", entityId: l.lapsingPolicyId }, select: { tenantId: true } }))
        .toEqual([{ tenantId: l.tenantId }])
      const flagged = await db.crmActivity.findMany({
        where: { clientId: l.clientId, type: "INSURANCE_OFFER" }, select: { tenantId: true, subject: true },
      })
      expect(flagged.map((f) => f.tenantId)).toEqual([l.tenantId])
      expect(flagged[0].subject).toContain(`ISIT-renew-`)
      expect(await db.notificationLog.findMany({ where: { clientId: l.clientId, event: "insurance_renewal_due" }, select: { tenantId: true } }))
        .toEqual([{ tenantId: l.tenantId }])
      expect((await db.insurancePolicy.findUniqueOrThrow({ where: { id: l.renewingPolicyId } })).status).toBe("ACTIVE")
    }
  })

  it("cross-sell sweeps every tenant, naming each opportunity with its own tenant", async () => {
    await creditLifeCandidate(a)
    await creditLifeCandidate(b)

    const response = await crossSell(cronRequest("/api/cron/cross-sell"))
    // Other suites' rows share this database, so the totals are lower bounds
    // and the overall status (503 if any tenant failed) is not this suite's concern.
    const body = await response.json() as { evaluated: number; created: number; perTenant: Array<{ tenantId: string; error?: string }> }
    expect(body.evaluated).toBeGreaterThanOrEqual(2)
    expect(body.created).toBeGreaterThanOrEqual(2)
    const own = body.perTenant.filter((t) => t.tenantId === a.tenantId || t.tenantId === b.tenantId)
    expect(own.map((t) => t.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort())
    expect(own.filter((t) => t.error)).toEqual([])

    for (const l of [a, b]) {
      expect(await db.crossSellOpportunity.findMany({
        where: { clientId: l.clientId, type: "CREDIT_LIFE" }, select: { tenantId: true, status: true },
      })).toEqual([{ tenantId: l.tenantId, status: "PENDING" }])
      // The seeded FUNERAL_COVER opportunity plus the new CREDIT_LIFE one.
      expect(await db.crossSellOpportunity.count({ where: { tenantId: l.tenantId } })).toBe(2)
    }

    // A second run finds each open opportunity through the tenant-scoped
    // duplicate check and creates nothing.
    await crossSell(cronRequest("/api/cron/cross-sell"))
    for (const l of [a, b]) {
      expect(await db.crossSellOpportunity.count({ where: { tenantId: l.tenantId, type: "CREDIT_LIFE" } })).toBe(1)
    }
  }, 30_000)
})
