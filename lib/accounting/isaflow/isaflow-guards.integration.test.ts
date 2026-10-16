/**
 * The database guards of 20261016100000_isaflow_connection_push, run against
 * a migrated Postgres: what holds even when application code is wrong.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/isaflow/isaflow-guards.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { closeMonth, isaflowTenant, IT_KEY } from "./isaflow.integration-fixture"
import { sha256Hex } from "./journal"
import { sealCredential } from "@/lib/integrations/tenant-credentials"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
// Minimal: the default format quotes the calling test line, regex included, into the message.
const db = new PrismaClient({ errorFormat: "minimal" })
let A: Awaited<ReturnType<typeof isaflowTenant>>
let B: Awaited<ReturnType<typeof isaflowTenant>>
let aug = ""
let sep = ""

const request = (batchId: string, memo = "m") => JSON.stringify({ date: "2026-08-31", memo: `${memo} [credaflow:${batchId}]`, idempotency_key: `credaflow:batch:${batchId}` })
const claim = (batchId: string, over: Record<string, unknown> = {}) => db.accountingIsaFlowPush.create({
  data: {
    tenantId: A.tenantId, batchId, status: "SENDING", externalRef: batchId, idempotencyKey: `credaflow:batch:${batchId}`,
    requestJson: request(batchId), requestSha256: sha256Hex(request(batchId)), isaflowCompanyId: "co-1", pushedById: A.userId, ...over,
  } as never,
})
const connection = (tenantId: string, over: Record<string, unknown> = {}) => ({
  tenantId, status: "CONNECTED" as const, baseUrl: "https://isaflow.example", tokenSealed: sealCredential("pat_guard_it_token"),
  isaflowCompanyId: "co-1", isaflowCompanyName: "Co", connectedById: A.userId, connectedWithTotp: true, connectedAt: new Date(), ...over,
})

suite.sequential("IsaFlow guards (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("WABA_ENC_KEY", IT_KEY)
    A = await isaflowTenant(db)
    B = await isaflowTenant(db)
    aug = await closeMonth(db, A, "2026-08", new Date("2026-11-01T00:00:00Z"))
    sep = await closeMonth(db, A, "2026-09", new Date("2026-11-01T00:00:00Z"))
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await db.$disconnect()
  })

  describe("AccountingIsaFlowPush", () => {
    it("starts as a SENDING claim on a closed batch of its own tenant, bound to the batch's key, reference and request hash", async () => {
      await expect(claim(aug, { status: "PUSHED", isaflowJournalId: "j" })).rejects.toThrow(/starts as a SENDING claim/)
      await expect(claim(aug, { tenantId: B.tenantId })).rejects.toThrow(/only a closed batch is pushed/)
      await expect(claim(aug, { idempotencyKey: "credaflow:batch:other" })).rejects.toThrow(/idempotency_key_bound/)
      await expect(claim(aug, { externalRef: "other" })).rejects.toThrow(/external_ref_bound/)
      await expect(claim(aug, { requestSha256: sha256Hex("something else") })).rejects.toThrow(/request_sha256/)
      await claim(aug)
    })

    it("starts empty and is claimed by a user of its own tenant", async () => {
      await expect(claim(sep, { isaflowJournalId: "j-0" })).rejects.toThrow(/starts with no journal, resolution or read-back/)
      await expect(claim(sep, { resolvedById: A.userId })).rejects.toThrow(/starts with no journal, resolution or read-back/)
      await expect(claim(sep, { resolutionNote: "pre-resolved" })).rejects.toThrow(/starts with no journal, resolution or read-back/)
      await expect(claim(sep, { foundOnReadBack: true })).rejects.toThrow(/starts with no journal, resolution or read-back/)
      await expect(claim(sep, { pushedById: B.userId })).rejects.toThrow(/claimed by a user of its tenant/)
      await expect(claim(sep, { pushedById: "nobody" })).rejects.toThrow(/claimed by a user of its tenant/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { pushedById: B.userId } })).rejects.toThrow(/claimed by a user of its tenant/)
    })

    it("never changes its request, hash, key or IsaFlow company", async () => {
      const other = request(aug, "changed")
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { requestJson: other, requestSha256: sha256Hex(other) } })).rejects.toThrow(/never change/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { idempotencyKey: "credaflow:batch:x" } })).rejects.toThrow(/never change/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { isaflowCompanyId: "co-2" } })).rejects.toThrow(/never change/)
    })

    it("records an IsaFlow journal id once; PUSHED needs one and is final", async () => {
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { status: "PUSHED" } })).rejects.toThrow(/pushed_has_journal/)
      await db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { status: "PUSHED", isaflowJournalId: "j-1" } })
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { isaflowJournalId: "j-2" } })).rejects.toThrow(/written once/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { isaflowJournalId: null } })).rejects.toThrow(/written once/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { status: "SENDING" } })).rejects.toThrow(/PUSHED -> SENDING is not allowed/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: aug }, data: { status: "FAILED" } })).rejects.toThrow(/PUSHED -> FAILED is not allowed/)
    })

    it("may go from review back to SENDING (same request, same key), never from SENDING to SENDING by a second claim", async () => {
      await claim(sep)
      await expect(claim(sep)).rejects.toThrow(/Unique constraint|batchId/)
      await db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "NEEDS_REVIEW" } })
      await db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "SENDING" } })
      await db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "NEEDS_REVIEW" } })
      // Out of review only by a resend (above) or a resolution that names a user of the tenant.
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "PUSHED", isaflowJournalId: "j-r" } })).rejects.toThrow(/resolved by a user of its tenant/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "FAILED" } })).rejects.toThrow(/resolved by a user of its tenant/)
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "FAILED", resolvedById: B.userId } })).rejects.toThrow(/resolved by a user of its tenant/)
      await db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "FAILED", resolvedById: A.userId, resolutionNote: "checked" } })
      await db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { status: "SENDING" } })
      await expect(db.accountingIsaFlowPush.update({ where: { batchId: sep }, data: { tenantId: B.tenantId } })).rejects.toThrow()
    })

    it("is never deleted or truncated", async () => {
      await expect(db.accountingIsaFlowPush.delete({ where: { batchId: aug } })).rejects.toThrow(/never deleted/)
      const truncated = await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE TABLE "AccountingIsaFlowPush"`)
        throw new Error("the TRUNCATE succeeded")
      }).catch((error: unknown) => error as Error)
      expect(truncated.message).toMatch(/AccountingIsaFlowPush is part of the closed months and is never truncated/)
    })
  })

  describe("IsaFlowConnection", () => {
    it("refuses CONNECTED without a TOTP-verified session, or for anyone but an active SUPER_ADMIN of the tenant", async () => {
      await expect(db.isaFlowConnection.create({ data: connection(A.tenantId, { connectedWithTotp: false }) })).rejects.toThrow(/TOTP-verified session/)
      const admin = await db.user.create({ data: { id: `u_${randomUUID()}`, tenantId: A.tenantId, email: `${randomUUID()}@test.invalid`, password: "x", role: "ADMIN" } })
      await expect(db.isaFlowConnection.create({ data: connection(A.tenantId, { connectedById: admin.id }) })).rejects.toThrow(/only an active SUPER_ADMIN/)
      await expect(db.isaFlowConnection.create({ data: connection(A.tenantId, { connectedById: B.userId }) })).rejects.toThrow(/only an active SUPER_ADMIN/)
      const inactive = await db.user.create({ data: { id: `u_${randomUUID()}`, tenantId: A.tenantId, email: `${randomUUID()}@test.invalid`, password: "x", role: "SUPER_ADMIN", active: false } })
      await expect(db.isaFlowConnection.create({ data: connection(A.tenantId, { connectedById: inactive.id }) })).rejects.toThrow(/only an active SUPER_ADMIN/)
      await db.isaFlowConnection.create({ data: connection(A.tenantId) })
      await expect(db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { connectedById: admin.id } })).rejects.toThrow(/only an active SUPER_ADMIN/)
    })

    it("stores a token only sealed and only while CONNECTED", async () => {
      await expect(db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { tokenSealed: "pat_plaintext_token" } })).rejects.toThrow(/token_sealed_iff_connected/)
      await expect(db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { status: "DISCONNECTED" } })).rejects.toThrow(/token_sealed_iff_connected/)
      await expect(db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { isaflowCompanyId: null } })).rejects.toThrow(/connected_has_company/)
    })

    it("needs a SUPER_ADMIN again to come back from NEEDS_RECONNECT; routine updates do not re-check the connector", async () => {
      await db.user.update({ where: { id: A.userId }, data: { role: "ADMIN" } })
      await db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { lastVerifiedAt: new Date() } })
      await db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { status: "NEEDS_RECONNECT", tokenSealed: null } })
      await expect(db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { status: "CONNECTED", tokenSealed: sealCredential("pat_guard_it_token2") } })).rejects.toThrow(/only an active SUPER_ADMIN/)
      await db.user.update({ where: { id: A.userId }, data: { role: "SUPER_ADMIN" } })
      await db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { status: "CONNECTED", tokenSealed: sealCredential("pat_guard_it_token2") } })
    })

    it("is never deleted and stays with its tenant", async () => {
      await expect(db.isaFlowConnection.delete({ where: { tenantId: A.tenantId } })).rejects.toThrow(/never deleted/)
      await expect(db.isaFlowConnection.update({ where: { tenantId: A.tenantId }, data: { tenantId: B.tenantId } })).rejects.toThrow(/stays with its tenant/)
    })
  })
})
