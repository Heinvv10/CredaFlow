/**
 * Real-Postgres proof that a recorded death silences the client's Contact, and
 * only that: which Contacts are blocked, which are re-opened, that the data
 * migration for earlier deaths is idempotent, and that the death, the block and
 * the audit row commit or roll back together.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/clients/deceased-contacts.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PrismaClient, type ContactStatus } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { evaluateEligibility } from "@/lib/messaging/eligibility"
import { provisionContactForClient } from "@/lib/contact/provision"
import {
  blockContactsForDeceasedClient, DECEASED_CONTACT_BLOCK_REASON, releaseContactsForRevivedClient,
} from "@/lib/clients/deceased-contacts"

const audit = vi.hoisted(() => ({ failAfterWriting: false }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: async () => ({ user: { id: process.env.IT_USER_ID!, email: "officer@test.invalid" } }),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: process.env.IT_TENANT_ID! }),
}))
// Writes the audit row inside the route's transaction, then fails: the whole unit must roll back.
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return {
    ...actual,
    logAuditStrict: async (...args: Parameters<typeof actual.logAuditStrict>) => {
      await actual.logAuditStrict(...args)
      if (audit.failAfterWriting) throw new Error("audit write failed")
    },
  }
})

import { prisma } from "@/lib/prisma"
import { PATCH } from "@/app/api/clients/[id]/status/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant

async function client(opts: { status?: ContactStatus; blockedAt?: Date; blockedReason?: string; deceasedAt?: Date } = {}) {
  const id = randomUUID().replaceAll("-", "").slice(0, 12)
  const c = await db.client.create({
    data: {
      tenantId: tenant.tenantId, idNumber: `92${id.slice(0, 11)}`, firstName: "Estate", lastName: "Test",
      email: `${id}@client.invalid`, phone: "0820000000", deceasedAt: opts.deceasedAt ?? null, deceasedReason: opts.deceasedAt ? "synthetic" : null,
    },
  })
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.tenantId, clientId: c.id, status: opts.status ?? "CLIENT", firstSeenChannel: "MANUAL", primaryEmail: `${id}@client.invalid`,
      blockedAt: opts.blockedAt ?? null, blockedReason: opts.blockedReason ?? null,
    },
  })
  return { clientId: c.id, contactId: contact.id }
}
const contactRow = (id: string) => db.contact.findUniqueOrThrow({ where: { id } })
const scope = (clientId: string) => ({ tenantId: tenant.tenantId, clientId })

suite.sequential("deceased client contacts (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    process.env.IT_TENANT_ID = tenant.tenantId
    process.env.IT_USER_ID = tenant.userId
  })
  afterAll(async () => { await db.$disconnect(); await prisma.$disconnect() })

  it("blocks only a CLIENT Contact, keeps an existing blockedAt, and the send gate then refuses every channel", async () => {
    const plain = await client()
    const suppressed = await client({ blockedAt: new Date("2026-03-01T00:00:00Z") })
    const staff = await client({ status: "STAFF" })
    const fraud = await client({ status: "BLOCKED", blockedAt: new Date("2026-02-01T00:00:00Z"), blockedReason: "fraud" })

    for (const c of [plain, suppressed, staff, fraud]) await blockContactsForDeceasedClient(db as never, scope(c.clientId))

    expect(await contactRow(plain.contactId)).toMatchObject({ status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON })
    expect((await contactRow(plain.contactId)).blockedAt).toBeInstanceOf(Date)
    expect((await contactRow(suppressed.contactId)).blockedAt).toEqual(new Date("2026-03-01T00:00:00Z"))
    expect(await contactRow(staff.contactId)).toMatchObject({ status: "STAFF", blockedReason: null })
    expect(await contactRow(fraud.contactId)).toMatchObject({ status: "BLOCKED", blockedReason: "fraud" })
    const template = { tenantId: tenant.tenantId, key: "payment_reminder", category: "SERVICE", statutoryOverride: false } as never
    for (const channel of ["EMAIL", "WHATSAPP", "SMS"] as const) {
      expect(await evaluateEligibility(db as never, plain.contactId, channel, template), channel).toEqual({ ok: false, reason: "BLOCKED" })
    }
  })

  it("re-opens only the Contacts the death blocked, and keeps a suppression that predates the death", async () => {
    const deceasedAt = new Date("2026-09-01T00:00:00Z")
    const ours = await client()
    const predating = await client({ blockedAt: new Date("2026-03-01T00:00:00Z") })
    const fraud = await client({ status: "BLOCKED", blockedAt: new Date("2026-02-01T00:00:00Z"), blockedReason: "fraud" })
    // Blocked, then the death is recorded after: the marker rows carry blockedAt >= deceasedAt only when we set it.
    await blockContactsForDeceasedClient(db as never, scope(ours.clientId))
    await blockContactsForDeceasedClient(db as never, scope(predating.clientId))
    await db.contact.update({ where: { id: ours.contactId }, data: { blockedAt: new Date("2026-09-02T00:00:00Z") } })

    for (const c of [ours, predating, fraud]) await releaseContactsForRevivedClient(db as never, { ...scope(c.clientId), deceasedAt })

    expect(await contactRow(ours.contactId)).toMatchObject({ status: "CLIENT", blockedAt: null, blockedReason: null })
    expect(await contactRow(predating.contactId)).toMatchObject({ status: "CLIENT", blockedReason: null, blockedAt: new Date("2026-03-01T00:00:00Z") })
    expect(await contactRow(fraud.contactId)).toMatchObject({ status: "BLOCKED", blockedReason: "fraud" })
  })

  it("the data migration blocks the Contacts of already-deceased clients, only CLIENT ones, and is idempotent", async () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261020040000_block_contacts_of_deceased_clients/migration.sql"), "utf8")
    // One statement per call (the driver prepares them); the RLS bypass pair around the UPDATE is part of the file.
    const statements = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n").split(";").map((t) => t.trim()).filter(Boolean)
    expect(statements.map((t) => t.split(/\s/)[0])).toEqual(["SELECT", "UPDATE", "SELECT"])
    expect(statements[0]).toContain("app.rls_bypass")
    const runMigration = async (tx: Pick<PrismaClient, "$executeRawUnsafe">) => {
      let updated = 0
      for (const statement of statements) {
        const result = await tx.$executeRawUnsafe(statement)
        if (statement.startsWith("UPDATE")) updated = result
      }
      return updated
    }
    const dead = await client({ deceasedAt: new Date("2026-08-01T00:00:00Z") })
    const deadSuppressed = await client({ deceasedAt: new Date("2026-08-01T00:00:00Z"), blockedAt: new Date("2026-03-01T00:00:00Z") })
    const deadStaff = await client({ deceasedAt: new Date("2026-08-01T00:00:00Z"), status: "STAFF" })
    const alive = await client()
    const rolledBack = new Error("roll back: the run must not leak into other suites")
    const seen: Record<string, unknown> = {}

    await db.$transaction(async (tx) => {
      seen.first = await runMigration(tx)
      seen.second = await runMigration(tx)
      seen.dead = await tx.contact.findUniqueOrThrow({ where: { id: dead.contactId } })
      seen.suppressed = await tx.contact.findUniqueOrThrow({ where: { id: deadSuppressed.contactId } })
      seen.staff = await tx.contact.findUniqueOrThrow({ where: { id: deadStaff.contactId } })
      seen.alive = await tx.contact.findUniqueOrThrow({ where: { id: alive.contactId } })
      throw rolledBack
    }).catch((e) => { if (e !== rolledBack) throw e })

    expect(seen.first).toBeGreaterThanOrEqual(2)
    expect(seen.second, "a second run matches nothing").toBe(0)
    expect(seen.dead).toMatchObject({ status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON })
    expect(seen.suppressed).toMatchObject({ status: "BLOCKED", blockedAt: new Date("2026-03-01T00:00:00Z") })
    expect(seen.staff).toMatchObject({ status: "STAFF" })
    expect(seen.alive).toMatchObject({ status: "CLIENT", blockedReason: null })
  })

  it("a Contact provisioned for an already-deceased client starts BLOCKED with the marker, and a revived client gets it back", async () => {
    const id = randomUUID().replaceAll("-", "").slice(0, 12)
    const deceasedAt = new Date("2026-08-01T00:00:00Z")
    const c = await db.client.create({
      data: { tenantId: tenant.tenantId, idNumber: `93${id.slice(0, 11)}`, firstName: "Late", lastName: "Contact", email: `${id}@client.invalid`, phone: "0820000000", deceasedAt, deceasedReason: "synthetic" },
    })
    const { contact } = await db.$transaction((tx) => provisionContactForClient(tx as never, { tenantId: tenant.tenantId, clientId: c.id, email: `${id}@client.invalid` }))
    expect(await contactRow(contact.id)).toMatchObject({ status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON })

    await releaseContactsForRevivedClient(db as never, { ...scope(c.id), deceasedAt })
    expect(await contactRow(contact.id)).toMatchObject({ status: "CLIENT", blockedReason: null, blockedAt: null })
  })

  it("a failing audit write rolls back the death, the Contact block and the audit row together", async () => {
    const c = await client()
    audit.failAfterWriting = true
    try {
      const res = await runWithTenant(tenant.tenantId, () => PATCH(
        new NextRequest("http://x/api/clients/c/status", { method: "PATCH", body: JSON.stringify({ deceased: true, reason: "Death certificate received" }) }),
        { params: Promise.resolve({ id: c.clientId }) },
      ))
      expect(res.status).toBe(500)
    } finally {
      audit.failAfterWriting = false
    }
    expect(await db.client.findUniqueOrThrow({ where: { id: c.clientId }, select: { deceasedAt: true } })).toEqual({ deceasedAt: null })
    expect(await contactRow(c.contactId)).toMatchObject({ status: "CLIENT", blockedAt: null, blockedReason: null })
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, entityId: c.clientId } })).toBe(0)
  })

  it("control: without the failure the same request commits all three", async () => {
    const c = await client()
    const res = await runWithTenant(tenant.tenantId, () => PATCH(
      new NextRequest("http://x/api/clients/c/status", { method: "PATCH", body: JSON.stringify({ deceased: true, reason: "Death certificate received" }) }),
      { params: Promise.resolve({ id: c.clientId }) },
    ))
    expect(res.status).toBe(200)
    expect((await db.client.findUniqueOrThrow({ where: { id: c.clientId } })).deceasedAt).toBeInstanceOf(Date)
    expect(await contactRow(c.contactId)).toMatchObject({ status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON })
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, entityId: c.clientId, action: "CLIENT_DECEASED_RECORDED" } })).toBe(1)
  })
})
