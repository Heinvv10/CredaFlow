/**
 * Real-Postgres proof of the DSAR decision-record export
 * (lib/learning-loop/dsar-export.ts): two lenders each hold a client with a
 * decision record reached through the client id, through the client's
 * application and through the client's loan, plus a stranger's records. The
 * export for a lender's client holds exactly those three rows, none of the
 * other lender's (even ones that name the same client, application and loan
 * ids), read by the migration owner (the explicit tenantId filters) and by a
 * role RLS binds. Every person and lender is synthetic.
 *
 *   RUN_DECISION_LOG_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/dsar-export.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { recordData } from "./decision-log"
import { decisionRecordsForClient, type DsarExportDb } from "./dsar-export"
import { consumerDeclineRecord } from "./records"

const suite = process.env.RUN_DECISION_LOG_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const ROLE = "cf_dsar_export_it"
let app: ReturnType<typeof createAppPrismaClient>

interface Lender { tenantId: string; clientId: string; applicationId: string; loanId: string; byClient: string; byApplication: string; byLoan: string }
const lenders: Lender[] = []
const owner = db as unknown as DsarExportDb

const decidedAt = (day: number) => new Date(Date.UTC(2026, 9, day, 8))
const REASON = "Synthetic override reason for the export."

async function record(tenantId: string, subject: { applicationId?: string | null; loanId?: string | null; clientId?: string | null }, day: number) {
  const base = recordData(consumerDeclineRecord({
    tenantId, applicationId: "placeholder", clientId: null, actor: { userId: "user-1", role: "LOAN_ADMIN" }, decidedAt: decidedAt(day), declineCategory: "OTHER",
  }))
  const row = await db.creditDecisionRecord.create({
    data: { ...base, applicationId: null, loanId: null, clientId: null, overridden: true, overrideReason: REASON, ...subject },
  })
  return row.id
}

async function lender(): Promise<Lender> {
  const tenant = await createChargesTenant(db, false)
  const { loanId, clientId } = await createChargesLoan(db, tenant)
  const { applicationId } = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { applicationId: true } })
  const stranger = await createChargesLoan(db, tenant)
  const strangerApp = (await db.loan.findUniqueOrThrow({ where: { id: stranger.loanId }, select: { applicationId: true } })).applicationId
  const byClient = await record(tenant.tenantId, { clientId, applicationId: "app-that-is-gone" }, 1)
  const byApplication = await record(tenant.tenantId, { applicationId }, 2)
  const byLoan = await record(tenant.tenantId, { loanId }, 3)
  // The same lender's other clients: never in this client's export.
  await record(tenant.tenantId, { clientId: stranger.clientId }, 4)
  await record(tenant.tenantId, { applicationId: strangerApp }, 5)
  await record(tenant.tenantId, { loanId: stranger.loanId }, 6)
  return { tenantId: tenant.tenantId, clientId, applicationId, loanId, byClient, byApplication, byLoan }
}

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

suite("DSAR export of decision records (real Postgres)", () => {
  beforeAll(async () => {
    lenders.push(await lender(), await lender())
    // Rows that name lender A's client, application and loan under lender B: a
    // wrong tenant filter would hand them to A's export.
    const [a, b] = lenders
    await record(b.tenantId, { clientId: a.clientId }, 7)
    await record(b.tenantId, { applicationId: a.applicationId }, 8)
    await record(b.tenantId, { loanId: a.loanId }, 9)
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    if (app) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE ${ROLE}`)
    }
    await db.$disconnect()
  })

  it("holds the client's records by client id, application and loan, with the override reason, and no one else's", async () => {
    for (const l of lenders) {
      const rows = await decisionRecordsForClient(owner, l.tenantId, l.clientId)
      expect(rows.map((r) => r.id)).toEqual([l.byClient, l.byApplication, l.byLoan])
      expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([l.tenantId]))
      expect(rows.every((r) => r.overrideReason === REASON)).toBe(true)
    }
  })

  it("is empty, not an error, for a client with no records and for no client", async () => {
    expect(await decisionRecordsForClient(owner, lenders[0].tenantId, "client-with-nothing")).toEqual([])
    expect(await decisionRecordsForClient(owner, lenders[0].tenantId, null)).toEqual([])
  })

  it("as a role RLS binds, returns the same rows from inside the lender's frame", async () => {
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createAppRole())
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
    for (const l of lenders) {
      const rows = await runWithTenant(l.tenantId, () => decisionRecordsForClient(app as unknown as DsarExportDb, l.tenantId, l.clientId))
      expect(rows.map((r) => r.id)).toEqual([l.byClient, l.byApplication, l.byLoan])
    }
  })
})
