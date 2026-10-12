/**
 * Real-Postgres proof that the breach log (the POPIA security-compromise
 * register) is tenant-scoped: two tenants, each with its own host and staff,
 * and neither can list, read or edit the other's entries.
 *
 * Only the session is stubbed. The role guard, the tenant resolver (by host),
 * the session-to-tenant binding, the Prisma tenant-scope extension and the
 * audit writer are the real ones.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/compliance/breach-log/routes.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { prisma } from "@/lib/prisma"
import { runWithTenant, TenantScopeError } from "@/lib/tenant-scope"
import { GET as list, POST as create } from "./route"
import { GET as read, PATCH as edit } from "./[id]/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

interface Site { tenantId: string; userId: string; email: string; host: string }

async function site(): Promise<Site> {
  const token = randomBytes(6).toString("hex")
  const host = `lender-${token}.breach-it.test`
  const tenant = await db.tenant.create({
    data: { slug: `breach-it-${token}`, name: `Breach IT ${token}`, status: "ACTIVE", domain: host },
  })
  const email = `staff-${token}@breach-it.test`
  const user = await db.user.create({
    data: { tenantId: tenant.id, email, name: "Synthetic Staff", role: "LOAN_ADMIN", password: "not-a-real-hash" },
  })
  return { tenantId: tenant.id, userId: user.id, email, host }
}
const signIn = (t: Site, role = "LOAN_ADMIN") => {
  session.current = { user: { id: t.userId, email: t.email, role, tenantId: t.tenantId } }
}
const request = (t: Site, path: string, method = "GET", body?: unknown) => new NextRequest(`http://${t.host}${path}`, {
  method,
  headers: { host: t.host, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const BASE = "/api/compliance/breach-log"
const incident = (description: string) => ({
  incidentDate: "2026-09-01",
  discoveredDate: "2026-09-02",
  description,
  affectedClients: 2,
  dataCategories: "Contact details",
})
/** Signs `t` in and logs an incident through the route; returns the new id. */
async function logIncident(t: Site, description: string): Promise<string> {
  signIn(t)
  const response = await create(request(t, BASE, "POST", incident(description)))
  expect(response.status).toBe(201)
  return ((await response.json()) as { id: string }).id
}
const listIds = async (t: Site) =>
  ((await (await list(request(t, BASE))).json()) as Array<{ id: string }>).map((l) => l.id)
const readOne = (t: Site, id: string) => read(request(t, `${BASE}/${id}`), { params: Promise.resolve({ id }) })
const editOne = (t: Site, id: string, body: unknown) =>
  edit(request(t, `${BASE}/${id}`, "PATCH", body), { params: Promise.resolve({ id }) })
const audits = (action: string, entityId: string) => db.auditLog.findMany({ where: { action, entityId } })
// A Prisma query starts when it is awaited, so it is awaited inside the frame:
// runWithTenant(id, () => prisma.x.findMany()) would run it after the frame closed.
const inTenant = <T>(t: Site, query: () => PromiseLike<T>) => runWithTenant(t.tenantId, async () => await query())

suite.sequential("breach log routes are tenant-scoped (real Postgres)", () => {
  let a: Site
  let b: Site
  let aId: string
  let bId: string

  beforeAll(async () => {
    a = await site()
    b = await site()
    aId = await logIncident(a, "Synthetic incident for tenant A.")
    bId = await logIncident(b, "Synthetic incident for tenant B.")
  })
  afterAll(async () => {
    session.current = null
    await db.$disconnect()
  })

  it("stamps a new entry with the caller's tenant and audits it there", async () => {
    const rowA = await db.breachLog.findUniqueOrThrow({ where: { id: aId } })
    const rowB = await db.breachLog.findUniqueOrThrow({ where: { id: bId } })
    expect(rowA).toMatchObject({ tenantId: a.tenantId, createdBy: a.userId, status: "OPEN" })
    expect(rowB).toMatchObject({ tenantId: b.tenantId, createdBy: b.userId, status: "OPEN" })

    const [audit] = await audits("BREACH_LOG_CREATED", aId)
    expect(audit).toMatchObject({ tenantId: a.tenantId, userId: a.userId, entity: "BreachLog" })
    expect(await audits("BREACH_LOG_CREATED", bId)).toMatchObject([{ tenantId: b.tenantId, userId: b.userId }])
  })

  it("ignores a tenantId in the body", async () => {
    signIn(a)
    const response = await create(request(a, BASE, "POST", { ...incident("Synthetic incident with a forged tenant."), tenantId: b.tenantId }))
    expect(response.status).toBe(201)
    const { id } = (await response.json()) as { id: string }
    expect((await db.breachLog.findUniqueOrThrow({ where: { id } })).tenantId).toBe(a.tenantId)
  })

  it("lists each tenant only its own entries", async () => {
    signIn(a)
    const idsA = await listIds(a)
    expect(idsA).toContain(aId)
    expect(idsA).not.toContain(bId)
    expect(await db.breachLog.count({ where: { id: { in: idsA }, tenantId: { not: a.tenantId } } })).toBe(0)

    signIn(b)
    expect(await listIds(b)).toEqual([bId])
  })

  it("answers 404 when tenant A reads tenant B's entry", async () => {
    signIn(a)
    const response = await readOne(a, bId)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Breach log not found" })
    expect((await readOne(a, aId)).status).toBe(200)
  })

  it("answers 404 when tenant A edits tenant B's entry, and changes and audits nothing", async () => {
    const before = await db.breachLog.findUniqueOrThrow({ where: { id: bId } })
    signIn(a)
    const response = await editOne(a, bId, { status: "RESOLVED", containmentAction: "Edited by another tenant.", reportedToIC: true })
    expect(response.status).toBe(404)
    expect(await db.breachLog.findUniqueOrThrow({ where: { id: bId } })).toEqual(before)
    expect(await audits("BREACH_LOG_UPDATED", bId)).toEqual([])
  })

  it("lets a tenant edit its own entry, with one audit row holding the old and new values", async () => {
    signIn(b)
    const response = await editOne(b, bId, { status: "CONTAINED", reportedToIC: true, reportedAt: "2026-09-03" })
    expect(response.status).toBe(200)
    const row = await db.breachLog.findUniqueOrThrow({ where: { id: bId } })
    expect(row).toMatchObject({ tenantId: b.tenantId, status: "CONTAINED", reportedToIC: true })

    const rows = await audits("BREACH_LOG_UPDATED", bId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tenantId: b.tenantId,
      userId: b.userId,
      oldValue: { status: "OPEN", reportedToIC: false, reportedAt: null },
      newValue: { status: "CONTAINED", reportedToIC: true, reportedAt: "2026-09-03T00:00:00.000Z" },
    })
  })

  it("refuses a tenant A session on tenant B's host before any entry is read", async () => {
    signIn(a)
    expect((await list(request(b, BASE))).status).toBe(403)
    expect((await readOne(b, bId)).status).toBe(403)
    expect((await editOne(b, bId, { status: "RESOLVED" })).status).toBe(403)
    expect((await db.breachLog.findUniqueOrThrow({ where: { id: bId } })).status).toBe("CONTAINED")
  })

  it("is refused below LOAN_ADMIN and when signed out", async () => {
    signIn(a, "CREDIT_OFFICER")
    expect((await list(request(a, BASE))).status).toBe(403)
    expect((await editOne(a, aId, { status: "RESOLVED" })).status).toBe(403)
    session.current = null
    expect((await list(request(a, BASE))).status).toBe(401)
    expect((await db.breachLog.findUniqueOrThrow({ where: { id: aId } })).status).toBe("OPEN")
  })

  // The routes pass tenantId explicitly; these exercise the tenant-scope
  // extension alone, the backstop for a query that forgets to.
  describe("the tenant-scope extension on BreachLog", () => {
    it("adds the frame's tenant to a read that names none", async () => {
      const rows = await inTenant(a, () => prisma.breachLog.findMany())
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.tenantId === a.tenantId)).toBe(true)
      expect(await inTenant(a, () => prisma.breachLog.findUnique({ where: { id: bId } }))).toBeNull()
    })

    it("stamps a create that names no tenant", async () => {
      // The generated type requires tenantId; the cast is the forgetful caller.
      const data = {
        incidentDate: new Date("2026-09-01"), discoveredDate: new Date("2026-09-02"),
        description: "Synthetic incident written without a tenant.", dataCategories: "Contact details",
      } as Prisma.BreachLogUncheckedCreateInput
      const row = await inTenant(a, () => prisma.breachLog.create({ data }))
      expect(row.tenantId).toBe(a.tenantId)
    })

    it("refuses an update or delete of another tenant's entry by id", async () => {
      const before = await db.breachLog.findUniqueOrThrow({ where: { id: bId } })
      await expect(inTenant(a, () =>
        prisma.breachLog.update({ where: { id: bId }, data: { status: "RESOLVED" } }),
      )).rejects.toMatchObject({ code: "P2025" })
      await expect(inTenant(a, () =>
        prisma.breachLog.delete({ where: { id: bId } }),
      )).rejects.toMatchObject({ code: "P2025" })
      expect(await db.breachLog.findUniqueOrThrow({ where: { id: bId } })).toEqual(before)
    })

    it("refuses a query with neither a frame nor a tenantId, and one naming another tenant", async () => {
      await expect(prisma.breachLog.findMany()).rejects.toBeInstanceOf(TenantScopeError)
      await expect(inTenant(a, () =>
        prisma.breachLog.findMany({ where: { tenantId: b.tenantId } }),
      )).rejects.toBeInstanceOf(TenantScopeError)
    })
  })
})
