/**
 * Real-Postgres proof that an automated portal refusal (a blacklisted client)
 * writes its APPLICATION_SUBMISSION_BLOCKED audit row and a SYSTEM
 * CreditDecisionRecord flagged for the POPIA s71 legal review
 * (lib/learning-loop/submission-refusal.ts, DESIGN.md decision 5), through the
 * production client (`createAppPrismaClient`: tenant-scope extension and RLS
 * hook) under a role row-level security binds (neither superuser nor
 * BYPASSRLS), as app/api/applications/[id]/decide/decision-log.integration.test.ts.
 *
 * Mocked, and why:
 *   - `@/lib/prisma`: `prisma` is replaced by the RLS-bound app client (a lazy
 *     proxy, since the role is created in beforeAll). Nothing else changes.
 *   - `@/lib/auth` `auth`: the client's portal session.
 *   - `@/lib/tenant` `withTenantContext`: resolves this suite's tenant and runs
 *     the handler in its `runWithTenant` frame, as the real one does after
 *     host and session checks this suite does not exercise.
 *   - `@/lib/notifications` `triggerNotification`: no outbound email/WhatsApp.
 *
 *   RUN_DECISION_LOG_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/portal/applications/submission-refusal.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", clientId: "" }))

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_target, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: holder.clientId, role: "CLIENT", email: `${holder.clientId}@test.invalid` } })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Refusal log IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async () => undefined),
}))

import { createAppPrismaClient } from "@/lib/prisma"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { POST } from "./route"

const RUN = process.env.RUN_DECISION_LOG_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const ROLE = "cf_refusal_log_it"
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `refusal-log-${t}`
const clientId = `refusal-log-client-${t}`
const db = new PrismaClient()
let app: ReturnType<typeof createAppPrismaClient> | undefined

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
  return password
}

function roleUrl(password: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

suite("automated portal refusal in the decision log (real Postgres, RLS-bound role)", () => {
  beforeAll(async () => {
    holder.tenantId = tenantId
    holder.clientId = clientId
    await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: `Refusal log IT ${t}` } })
    await db.client.create({
      data: {
        id: clientId, tenantId, reference: `CLI-${t}`, idNumber: syntheticSaIdNumber(), firstName: "Synthetic", lastName: "Applicant",
        email: `${clientId}@test.invalid`, phone: "+27820000000", monthlyIncome: 2_000_000, monthlyExpenses: 800_000, blacklisted: true,
      },
    })
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(roleUrl(await createAppRole()))
    holder.app = app
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    // Append-only: the replica role skips its trigger, as cleanupDealFixture does.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.creditDecisionRecord.deleteMany({ where: { tenantId } }),
      db.auditLog.deleteMany({ where: { tenantId } }),
      db.client.deleteMany({ where: { tenantId } }),
      db.tenant.deleteMany({ where: { id: tenantId } }),
    ])
    if (app) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE ${ROLE}`)
    }
    await db.$disconnect()
  })

  it("connects as a role RLS binds (otherwise the proof below proves nothing)", async () => {
    const [me] = await app!.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("refuses a blacklisted client and commits the audit row with a SYSTEM record flagged for s71 review", async () => {
    const res = await POST(new NextRequest("http://localhost/api/portal/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productCode: "ANY", amount: 5000, purpose: "Synthetic purpose", affordabilityDeclared: true, pasqDeliveryUnderstood: true }),
    }))
    expect(res.status).toBe(422)
    expect(await db.loanApplication.count({ where: { tenantId } })).toBe(0)

    const audits = await db.auditLog.findMany({ where: { tenantId, action: "APPLICATION_SUBMISSION_BLOCKED" } })
    expect(audits).toHaveLength(1)
    expect(audits[0].newValue).toMatchObject({ reason: "client_blacklisted", clientId })

    const records = await db.creditDecisionRecord.findMany({ where: { tenantId } })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: "CREDIT_DECISION", decision: "DECLINE", recommendation: "BLOCK", overridden: false,
      actorType: "SYSTEM", actorUserId: null, clientId, leadId: null, s71ReviewRequired: true,
      sourceEntityType: "Client", sourceEntityId: clientId, ruleVersion: "decision-log-v1+submission-refusal-v1",
    })
    expect(records[0].inputsSnapshot).toEqual({ channel: "PORTAL", refusalReason: "client_blacklisted", refusalClass: "CREDIT", automated: true })
    expect(JSON.stringify(records[0])).not.toContain("@test.invalid")
  })
})
