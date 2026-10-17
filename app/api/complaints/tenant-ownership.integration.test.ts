/**
 * Real-Postgres proof, with two tenants, that the complaint, DSAR and branch
 * routes refuse an id from another tenant and that every write lands its audit
 * row in the same transaction.
 *
 * Only the session is stubbed. The role guard, the tenant resolver (by host),
 * the session-to-tenant binding, the tenant-scope extension and the audit
 * writer are the real ones.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/complaints/tenant-ownership.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { GET as listComplaints, POST as createComplaint } from "./route"
import { GET as readComplaint, PATCH as updateComplaint } from "./[id]/route"
import { GET as listDsars, POST as createDsar } from "../dsar/route"
import { PATCH as updateDsar } from "../dsar/[id]/route"
import { POST as createBranch } from "../branches/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const blocker = new PrismaClient()

interface Site { tenantId: string; host: string; userId: string; clientId: string }

async function site(): Promise<Site> {
  const t = randomUUID().replaceAll("-", "").slice(0, 16)
  const tenantId = `t_own_${t}`
  const host = `own-${t}.ownership-it.test`
  await db.tenant.create({ data: { id: tenantId, slug: `own-${t}`, name: "Ownership IT", domain: host } })
  const staff = await db.user.create({ data: { tenantId, email: `${t}@staff.invalid`, password: "x", role: "ADMIN" } })
  const client = await db.client.create({
    data: { tenantId, idNumber: syntheticSaId(), firstName: "Ownership", lastName: "Fixture", email: `${t}@client.invalid`, phone: "0820000000" },
  })
  return { tenantId, host, userId: staff.id, clientId: client.id }
}
const signIn = (t: Site, userId = t.userId) => {
  session.current = { user: { id: userId, email: "staff@ownership-it.test", role: "ADMIN", tenantId: t.tenantId } }
}
const request = (t: Site, path: string, method = "GET", body?: unknown) => new NextRequest(`http://${t.host}${path}`, {
  method,
  headers: { host: t.host, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const postComplaint = (t: Site, body: unknown) => createComplaint(request(t, "/api/complaints", "POST", body))
const patchComplaint = (t: Site, id: string, body: unknown) =>
  updateComplaint(request(t, `/api/complaints/${id}`, "PATCH", body), params(id))
const postDsar = (t: Site, body: unknown) => createDsar(request(t, "/api/dsar", "POST", body))
const patchDsar = (t: Site, id: string, body: unknown) => updateDsar(request(t, `/api/dsar/${id}`, "PATCH", body), params(id))
const postBranch = (t: Site, body: unknown) => createBranch(request(t, "/api/branches", "POST", body))

const audits = (...sites: Site[]) => db.auditLog.findMany({ where: { tenantId: { in: sites.map((s) => s.tenantId) } } })
const complaintBody = (clientId: string) => ({ clientId, category: "SERVICE_QUALITY", description: "Synthetic complaint" })

const lockWaiters = async () => {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`
  return Number(rows[0].n)
}

// Fires the requests while another transaction holds the row, then releases
// it. With the route's own FOR UPDATE each request waits before it reads the
// row, so the second reads what the first committed. Without it both read the
// row at once, wait only on their UPDATE, and both audit the same old value.
// Either way two lock waiters appear, which is when the row is released.
const raceBehindRowLock = async (table: "Complaint" | "DataSubjectRequest", id: string, fire: (() => Promise<Response>)[]) => {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let locked!: () => void
  const lockTaken = new Promise<void>((resolve) => { locked = resolve })
  const hold = blocker.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} FOR UPDATE`)
    locked()
    await released
  }, { timeout: 60_000 })
  await lockTaken

  let settled = 0
  const requests = fire.map((send) => send().finally(() => { settled++ }))
  const deadline = Date.now() + 5_000
  while (settled < fire.length && Date.now() < deadline && (await lockWaiters()) < fire.length) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  release()
  await hold
  return Promise.all(requests)
}

// The two audit rows of a race must form a chain from the starting status to
// the stored one: the old value of each is the status that write replaced.
const expectStatusChain = (rows: { oldValue: unknown; newValue: unknown }[], from: string, stored: string) => {
  const steps = rows.map((row) => [(row.oldValue as { status: string }).status, (row.newValue as { status: string }).status])
  expect(steps).toHaveLength(2)
  const first = steps.find(([old]) => old === from)
  const second = steps.find((step) => step !== first)
  expect(first, `one write replaced ${from}: ${JSON.stringify(steps)}`).toBeDefined()
  expect(second?.[0], JSON.stringify(steps)).toBe(first?.[1])
  expect(second?.[1]).toBe(stored)
}

suite.sequential("complaint, DSAR and branch routes across two tenants (real Postgres)", () => {
  afterAll(async () => {
    await db.$disconnect()
    await blocker.$disconnect()
  })

  describe("the tenant scope", () => {
    it("keeps a lookup by id inside the caller's tenant, and does not check a clientId it is handed", async () => {
      const a = await site()
      const b = await site()
      // Awaited inside the frame: a Prisma query runs when it is awaited, not when it is built.
      const find = (id: string) => runWithTenant(a.tenantId, async () => await prisma.client.findFirst({ where: { id } }))
      expect(await find(b.clientId)).toBeNull()
      expect(await find(a.clientId)).not.toBeNull()

      // Which is why the routes check: the write below is the bug they close.
      const crossed = await runWithTenant(a.tenantId, async () => await prisma.complaint.create({
        data: { tenantId: a.tenantId, clientId: b.clientId, reference: `COMP-IT-${randomUUID()}`, category: "OTHER", description: "Synthetic", createdById: a.userId },
      }))
      expect(crossed).toMatchObject({ tenantId: a.tenantId, clientId: b.clientId })
    })
  })

  describe("complaints", () => {
    it("refuses another tenant's clientId exactly as one that does not exist, writing nothing", async () => {
      const a = await site()
      const b = await site()
      signIn(a)
      const foreign = await postComplaint(a, complaintBody(b.clientId))
      const missing = await postComplaint(a, complaintBody("client-that-does-not-exist"))
      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(await foreign.json()).toEqual(await missing.json())
      expect(await db.complaint.count({ where: { OR: [{ tenantId: { in: [a.tenantId, b.tenantId] } }, { clientId: b.clientId }] } })).toBe(0)
      expect(await audits(a, b)).toEqual([])
    })

    it("creates one for the caller's own client, with its audit row", async () => {
      const a = await site()
      signIn(a)
      const response = await postComplaint(a, { ...complaintBody(a.clientId), assignedToId: a.userId })
      expect(response.status).toBe(201)
      const created = await response.json()
      const row = await db.complaint.findUniqueOrThrow({ where: { id: created.id } })
      expect(row).toMatchObject({ tenantId: a.tenantId, clientId: a.clientId, status: "OPEN", assignedToId: a.userId, createdById: a.userId })
      const rows = await audits(a)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tenantId: a.tenantId, userId: a.userId, action: "COMPLAINT_CREATED", entity: "Complaint", entityId: row.id,
        newValue: { reference: row.reference, clientId: a.clientId, category: "SERVICE_QUALITY", status: "OPEN", assignedToId: a.userId },
      })
    })

    it("refuses another tenant's staff as assignee, on create and on update, writing nothing", async () => {
      const a = await site()
      const b = await site()
      signIn(a)
      expect((await postComplaint(a, { ...complaintBody(a.clientId), assignedToId: b.userId })).status).toBe(404)
      expect(await db.complaint.count({ where: { tenantId: a.tenantId } })).toBe(0)

      const own = await (await postComplaint(a, complaintBody(a.clientId))).json()
      const foreign = await patchComplaint(a, own.id, { assignedToId: b.userId, status: "ESCALATED" })
      const missing = await patchComplaint(a, own.id, { assignedToId: "user-that-does-not-exist", status: "ESCALATED" })
      expect(foreign.status).toBe(404)
      expect(await foreign.json()).toEqual(await missing.json())
      expect(await db.complaint.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ assignedToId: null, status: "OPEN" })
      expect((await audits(a, b)).map((row) => row.action)).toEqual(["COMPLAINT_CREATED"])
    })

    it("does not read, list or update another tenant's complaint", async () => {
      const a = await site()
      const b = await site()
      signIn(b)
      const theirs = await (await postComplaint(b, complaintBody(b.clientId))).json()
      signIn(a)
      const foreign = await patchComplaint(a, theirs.id, { status: "CLOSED", resolution: "Synthetic" })
      const missing = await patchComplaint(a, "complaint-that-does-not-exist", { status: "CLOSED", resolution: "Synthetic" })
      expect(foreign.status).toBe(404)
      expect(await foreign.json()).toEqual(await missing.json())
      expect((await readComplaint(request(a, `/api/complaints/${theirs.id}`), params(theirs.id))).status).toBe(404)
      expect(await (await listComplaints(request(a, `/api/complaints?clientId=${b.clientId}`))).json()).toEqual([])
      expect(await db.complaint.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ status: "OPEN", resolution: null, resolvedAt: null })
      expect(await audits(a)).toEqual([])
      expect((await audits(b)).map((row) => row.action)).toEqual(["COMPLAINT_CREATED"])
    })

    it("audits a status change, an assignment and a close with the old and the new values", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postComplaint(a, complaintBody(a.clientId))).json()
      expect((await patchComplaint(a, own.id, { status: "UNDER_INVESTIGATION", assignedToId: a.userId })).status).toBe(200)
      expect((await patchComplaint(a, own.id, { status: "CLOSED", outcome: "UPHELD", resolution: "Synthetic resolution" })).status).toBe(200)

      const row = await db.complaint.findUniqueOrThrow({ where: { id: own.id } })
      expect(row).toMatchObject({ status: "CLOSED", outcome: "UPHELD", assignedToId: a.userId, resolution: "Synthetic resolution" })
      const updates = await db.auditLog.findMany({ where: { tenantId: a.tenantId, action: "COMPLAINT_UPDATED" }, orderBy: { createdAt: "asc" } })
      expect(updates).toHaveLength(2)
      for (const update of updates) expect(update).toMatchObject({ userId: a.userId, entity: "Complaint", entityId: own.id })
      expect(updates[0]).toMatchObject({
        oldValue: { status: "OPEN", assignedToId: null, acknowledgedAt: null },
        newValue: { status: "UNDER_INVESTIGATION", assignedToId: a.userId, acknowledgedAt: row.acknowledgedAt?.toISOString() },
      })
      expect(updates[1]).toMatchObject({
        oldValue: { status: "UNDER_INVESTIGATION", outcome: null, resolvedAt: null },
        newValue: { status: "CLOSED", outcome: "UPHELD", resolvedAt: row.resolvedAt?.toISOString(), resolutionChanged: true },
      })
      expect(JSON.stringify(updates)).not.toContain("Synthetic resolution")
    })

    it("refuses a null or unparseable resolvedAt and an empty PATCH, and keeps the first resolvedAt on a re-close", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postComplaint(a, complaintBody(a.clientId))).json()
      for (const body of [{ resolvedAt: null }, { resolvedAt: "not-a-date" }, {}]) {
        expect((await patchComplaint(a, own.id, body)).status, JSON.stringify(body)).toBe(400)
      }
      expect(await db.complaint.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ status: "OPEN", resolvedAt: null })
      expect((await audits(a)).map((row) => row.action)).toEqual(["COMPLAINT_CREATED"])

      expect((await patchComplaint(a, own.id, { status: "RESOLVED" })).status).toBe(200)
      const resolvedAt = (await db.complaint.findUniqueOrThrow({ where: { id: own.id } })).resolvedAt
      expect(resolvedAt).toBeInstanceOf(Date)
      expect((await patchComplaint(a, own.id, { status: "CLOSED" })).status).toBe(200)
      expect(await db.complaint.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ status: "CLOSED", resolvedAt })
    })

    it("clears resolvedAt on reopening and stamps a new one on the next resolution, auditing each", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postComplaint(a, complaintBody(a.clientId))).json()
      const resolvedAt = async () => (await db.complaint.findUniqueOrThrow({ where: { id: own.id } })).resolvedAt
      expect((await patchComplaint(a, own.id, { status: "RESOLVED" })).status).toBe(200)
      const first = await resolvedAt()
      expect(first).toBeInstanceOf(Date)
      expect((await patchComplaint(a, own.id, { status: "UNDER_INVESTIGATION" })).status).toBe(200)
      expect(await resolvedAt()).toBeNull()
      expect((await patchComplaint(a, own.id, { status: "RESOLVED" })).status).toBe(200)
      const second = await resolvedAt()
      expect(second!.getTime()).toBeGreaterThan(first!.getTime())

      const updates = await db.auditLog.findMany({ where: { tenantId: a.tenantId, action: "COMPLAINT_UPDATED" }, orderBy: { createdAt: "asc" } })
      expect(updates.map((row) => [row.oldValue, row.newValue])).toEqual([
        // Resolving an open complaint answers it, so it is acknowledged then.
        [{ status: "OPEN", resolvedAt: null, acknowledgedAt: null }, { status: "RESOLVED", resolvedAt: first!.toISOString(), acknowledgedAt: expect.any(String) }],
        [{ status: "RESOLVED", resolvedAt: first!.toISOString() }, { status: "UNDER_INVESTIGATION", resolvedAt: null }],
        [{ status: "UNDER_INVESTIGATION", resolvedAt: null }, { status: "RESOLVED", resolvedAt: second!.toISOString() }],
      ])
    })

    it("acknowledges an open complaint without moving it, once, audited", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postComplaint(a, complaintBody(a.clientId))).json()
      expect((await patchComplaint(a, own.id, { acknowledge: true })).status).toBe(200)
      const stored = await db.complaint.findUniqueOrThrow({ where: { id: own.id } })
      expect(stored).toMatchObject({ status: "OPEN", acknowledgedAt: expect.any(Date) })
      expect((await patchComplaint(a, own.id, { acknowledge: true })).status).toBe(200)
      expect((await db.complaint.findUniqueOrThrow({ where: { id: own.id } })).acknowledgedAt).toEqual(stored.acknowledgedAt)
      const updates = await db.auditLog.findMany({ where: { tenantId: a.tenantId, action: "COMPLAINT_UPDATED" } })
      expect(updates.map((row) => [row.oldValue, row.newValue])).toEqual([
        [{ acknowledgedAt: null }, { acknowledgedAt: stored.acknowledgedAt!.toISOString() }],
      ])
    })

    it("writes neither the complaint nor the change when the audit row cannot be written", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postComplaint(a, complaintBody(a.clientId))).json()
      // AuditLog.userId is a foreign key: a user id that names nobody fails the audit insert.
      signIn(a, "user-that-does-not-exist")
      await expect(postComplaint(a, complaintBody(a.clientId))).rejects.toThrow()
      await expect(patchComplaint(a, own.id, { status: "ESCALATED" })).rejects.toThrow()
      expect(await db.complaint.findMany({ where: { tenantId: a.tenantId }, select: { id: true, status: true } }))
        .toEqual([{ id: own.id, status: "OPEN" }])
      expect((await audits(a)).map((row) => row.action)).toEqual(["COMPLAINT_CREATED"])
    })

    it("audits each of two concurrent status changes against the status it replaced", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postComplaint(a, complaintBody(a.clientId))).json()
      const responses = await raceBehindRowLock("Complaint", own.id, [
        () => patchComplaint(a, own.id, { status: "ESCALATED" }),
        () => patchComplaint(a, own.id, { status: "RESOLVED" }),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const stored = await db.complaint.findUniqueOrThrow({ where: { id: own.id } })
      expectStatusChain(await db.auditLog.findMany({ where: { tenantId: a.tenantId, action: "COMPLAINT_UPDATED" } }), "OPEN", stored.status)
    })
  })

  describe("data subject requests", () => {
    it("refuses another tenant's clientId exactly as one that does not exist, writing nothing", async () => {
      const a = await site()
      const b = await site()
      signIn(a)
      const foreign = await postDsar(a, { clientId: b.clientId, type: "ACCESS" })
      const missing = await postDsar(a, { clientId: "client-that-does-not-exist", type: "ACCESS" })
      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(await foreign.json()).toEqual(await missing.json())
      expect(await db.dataSubjectRequest.count({ where: { OR: [{ tenantId: { in: [a.tenantId, b.tenantId] } }, { clientId: b.clientId }] } })).toBe(0)
      expect(await audits(a, b)).toEqual([])
    })

    it("creates one for the caller's own client and audits it and its completion", async () => {
      const a = await site()
      signIn(a)
      const response = await postDsar(a, { clientId: a.clientId, type: "DELETION", description: "Synthetic request" })
      expect(response.status).toBe(201)
      const created = await response.json()
      expect((await patchDsar(a, created.id, { status: "COMPLETED", response: "Synthetic response" })).status).toBe(200)

      const row = await db.dataSubjectRequest.findUniqueOrThrow({ where: { id: created.id } })
      expect(row).toMatchObject({ tenantId: a.tenantId, clientId: a.clientId, status: "COMPLETED", response: "Synthetic response" })
      const rows = await db.auditLog.findMany({ where: { tenantId: a.tenantId }, orderBy: { createdAt: "asc" } })
      expect(rows.map((audit) => audit.action)).toEqual(["DSAR_CREATED", "DSAR_UPDATED"])
      for (const audit of rows) expect(audit).toMatchObject({ userId: a.userId, entity: "DataSubjectRequest", entityId: row.id })
      expect(rows[0].newValue).toEqual({
        reference: row.reference, clientId: a.clientId, type: "DELETION", status: "RECEIVED", dueDate: row.dueDate.toISOString(),
      })
      expect(rows[1]).toMatchObject({
        oldValue: { status: "RECEIVED", completedAt: null },
        newValue: { status: "COMPLETED", completedAt: row.completedAt?.toISOString(), responseChanged: true },
      })
      expect(JSON.stringify(rows)).not.toMatch(/Synthetic (request|response)/)
    })

    it("does not list or update another tenant's request", async () => {
      const a = await site()
      const b = await site()
      signIn(b)
      const theirs = await (await postDsar(b, { clientId: b.clientId, type: "ACCESS" })).json()
      signIn(a)
      const foreign = await patchDsar(a, theirs.id, { status: "REFUSED", response: "Synthetic" })
      const missing = await patchDsar(a, "dsar-that-does-not-exist", { status: "REFUSED", response: "Synthetic" })
      expect(foreign.status).toBe(404)
      expect(await foreign.json()).toEqual(await missing.json())
      expect(await (await listDsars(request(a, `/api/dsar?clientId=${b.clientId}`))).json()).toEqual([])
      expect(await db.dataSubjectRequest.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ status: "RECEIVED", response: null })
      expect(await audits(a)).toEqual([])
      expect((await audits(b)).map((row) => row.action)).toEqual(["DSAR_CREATED"])
    })

    it("refuses a null or unparseable completedAt and an empty PATCH, and keeps the first completedAt", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postDsar(a, { clientId: a.clientId, type: "ACCESS" })).json()
      for (const body of [{ completedAt: null }, { completedAt: "not-a-date" }, {}]) {
        expect((await patchDsar(a, own.id, body)).status, JSON.stringify(body)).toBe(400)
      }
      expect(await db.dataSubjectRequest.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ status: "RECEIVED", completedAt: null })
      expect((await audits(a)).map((row) => row.action)).toEqual(["DSAR_CREATED"])

      expect((await patchDsar(a, own.id, { status: "COMPLETED" })).status).toBe(200)
      const completedAt = (await db.dataSubjectRequest.findUniqueOrThrow({ where: { id: own.id } })).completedAt
      expect(completedAt).toBeInstanceOf(Date)
      expect((await patchDsar(a, own.id, { status: "COMPLETED", response: "Synthetic follow-up" })).status).toBe(200)
      expect(await db.dataSubjectRequest.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ status: "COMPLETED", completedAt })
    })

    it("stamps completedAt on a refusal, keeps it into completion, clears it on reopening, auditing each", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postDsar(a, { clientId: a.clientId, type: "ACCESS" })).json()
      const completedAt = async () => (await db.dataSubjectRequest.findUniqueOrThrow({ where: { id: own.id } })).completedAt
      expect((await patchDsar(a, own.id, { status: "REFUSED" })).status).toBe(200)
      const first = await completedAt()
      expect(first).toBeInstanceOf(Date)
      expect((await patchDsar(a, own.id, { status: "COMPLETED" })).status).toBe(200)
      expect(await completedAt()).toEqual(first)
      expect((await patchDsar(a, own.id, { status: "IN_PROGRESS" })).status).toBe(200)
      expect(await completedAt()).toBeNull()

      const updates = await db.auditLog.findMany({ where: { tenantId: a.tenantId, action: "DSAR_UPDATED" }, orderBy: { createdAt: "asc" } })
      expect(updates.map((row) => [row.oldValue, row.newValue])).toEqual([
        [{ status: "RECEIVED", completedAt: null }, { status: "REFUSED", completedAt: first!.toISOString() }],
        [{ status: "REFUSED" }, { status: "COMPLETED" }],
        [{ status: "COMPLETED", completedAt: first!.toISOString() }, { status: "IN_PROGRESS", completedAt: null }],
      ])
    })

    it("writes neither the request nor the change when the audit row cannot be written", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postDsar(a, { clientId: a.clientId, type: "ACCESS" })).json()
      signIn(a, "user-that-does-not-exist")
      await expect(postDsar(a, { clientId: a.clientId, type: "ACCESS" })).rejects.toThrow()
      await expect(patchDsar(a, own.id, { status: "IN_PROGRESS" })).rejects.toThrow()
      expect(await db.dataSubjectRequest.findMany({ where: { tenantId: a.tenantId }, select: { id: true, status: true } }))
        .toEqual([{ id: own.id, status: "RECEIVED" }])
      expect((await audits(a)).map((row) => row.action)).toEqual(["DSAR_CREATED"])
    })

    it("audits each of two concurrent status changes against the status it replaced", async () => {
      const a = await site()
      signIn(a)
      const own = await (await postDsar(a, { clientId: a.clientId, type: "ACCESS" })).json()
      const responses = await raceBehindRowLock("DataSubjectRequest", own.id, [
        () => patchDsar(a, own.id, { status: "IN_PROGRESS" }),
        () => patchDsar(a, own.id, { status: "REFUSED" }),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const stored = await db.dataSubjectRequest.findUniqueOrThrow({ where: { id: own.id } })
      expectStatusChain(await db.auditLog.findMany({ where: { tenantId: a.tenantId, action: "DSAR_UPDATED" } }), "RECEIVED", stored.status)
    })
  })

  describe("branches", () => {
    it("refuses another tenant's staff as manager exactly as one that does not exist, writing nothing", async () => {
      const a = await site()
      const b = await site()
      signIn(a)
      const foreign = await postBranch(a, { name: "Synthetic Branch", code: "syn", managerId: b.userId })
      const missing = await postBranch(a, { name: "Synthetic Branch", code: "syn", managerId: "user-that-does-not-exist" })
      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(await foreign.json()).toEqual(await missing.json())
      expect(await db.branch.count({ where: { OR: [{ tenantId: { in: [a.tenantId, b.tenantId] } }, { managerId: b.userId }] } })).toBe(0)
      expect(await audits(a, b)).toEqual([])
    })

    it("refuses as manager the caller's own staff whose role the page does not offer", async () => {
      const a = await site()
      const officer = await db.user.create({ data: { tenantId: a.tenantId, email: `${randomUUID()}@staff.invalid`, password: "x", role: "CREDIT_OFFICER" } })
      signIn(a)
      expect((await postBranch(a, { name: "Synthetic Branch", code: "syn", managerId: officer.id })).status).toBe(404)
      expect(await db.branch.count({ where: { tenantId: a.tenantId } })).toBe(0)
      expect(await audits(a)).toEqual([])
    })

    it("creates one with the caller's own manager, with its audit row, and neither when the audit row cannot be written", async () => {
      const a = await site()
      signIn(a)
      const response = await postBranch(a, { name: "Synthetic Branch", code: "syn", managerId: a.userId })
      expect(response.status).toBe(201)
      const created = await response.json()
      expect(await db.branch.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ tenantId: a.tenantId, code: "SYN", managerId: a.userId })
      const rows = await audits(a)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tenantId: a.tenantId, userId: a.userId, action: "BRANCH_CREATED", entity: "Branch", entityId: created.id,
        newValue: { name: "Synthetic Branch", code: "SYN", managerId: a.userId },
      })

      signIn(a, "user-that-does-not-exist")
      await expect(postBranch(a, { name: "Second Synthetic Branch", code: "syn2" })).rejects.toThrow()
      expect(await db.branch.count({ where: { tenantId: a.tenantId } })).toBe(1)
      expect(await audits(a)).toHaveLength(1)
    })
  })
})
