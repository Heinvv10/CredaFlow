import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest"
import { createSigningFixture, cleanupSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "./deal-signing.integration-fixture"
import { dealStartDate } from "./deal-structure"
import { isoOfDbDate } from "./dates"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: { id: string; role: string; email: string; tenantId: string } } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const run = process.env.RUN_ASSET_FINANCE_SIGNING_IT === "1"
const db = run ? new PrismaClient() : null
const suite = run ? describe.sequential : describe.skip
let fx: SigningFixture
suite("surety consent evidence concurrency", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    const t = randomUUID().replaceAll("-", "").slice(0, 16)
    fx = await createSigningFixture(db!, t, (id, role) => { session.current = { user: { id, role, email: "test@review.invalid", tenantId: `t_af_deal_${t}` } } })
    await db!.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: SYNTHETIC_IDENTITY })
    const deal = await db!.assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })
    session.current = { user: { id: fx.officer, role: "CREDIT_OFFICER", email: "test@review.invalid", tenantId: fx.tenantId } }
    expect((await signingRoutes(fx.host).prepare(fx.dealId, { plannedStartDate: dealStartDate(isoOfDbDate(deal.firstDueDate)) })).status).toBe(200)
  }, 120000)
  afterAll(async () => { if (fx) await cleanupSigningFixture(db!, fx); await db!.$disconnect(); vi.unstubAllEnvs() })
  const evidence = () => db!.entityDocument.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, dealId: fx.dealId, docType: "LEGAL_DOCUMENT", fileName: "TEST-consent.pdf", mimeType: "application/pdf", fileSize: 10, storagePath: "/tmp/TEST-security-consent", contentSha256: "a".repeat(64), uploadedByType: "staff", uploadedById: fx.officer } })
  const consentData = (signerId: string, documentId: string) => ({ tenantId: fx.tenantId, signerId, maritalRegime: "IN_COMMUNITY", spouseName: "TEST Spouse", witnessOne: "TEST One", witnessTwo: "TEST Two", evidenceDocumentId: documentId, verifiedById: fx.officer, suretySignedOn: new Date("2026-10-17"), consentSignedOn: new Date("2026-10-16"), consentBeforeSurety: true })
  async function waitForLock(pid: number) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const rows = await db!.$queryRaw<Array<{ waiting: boolean }>>`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`
      if (rows[0]?.waiting) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error("Expected database lock wait")
  }
  it("consent first: concurrent proof deletion waits, then existing retention guard refuses", async () => {
    const signer = await db!.dealSigner.findFirstOrThrow({ where: { dealId: fx.dealId, document: "SURETYSHIP", clientId: fx.suretyA } })
    const doc = await evidence()
    let inserted!: () => void; const ready = new Promise<void>(r => inserted = r)
    let release!: () => void; const commit = new Promise<void>(r => release = r)
    const create = db!.$transaction(async tx => {
      const row = await tx.suretyConsent.create({ data: consentData(signer.id, doc.id) })
      inserted(); await commit; return row
    }, { timeout: 15000 })
    await ready
    let deleting!: (pid: number) => void; const deletionPid = new Promise<number>(r => deleting = r)
    const deletion = db!.$transaction(async tx => {
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      deleting(row.pid)
      await tx.entityDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date(), deletedById: fx.officer } })
    }).then(() => null, error => String(error))
    try { await waitForLock(await deletionPid) } finally { release() }
    const consent = await create
    expect(await deletion).toContain("A verified spouse consent document is immutable")
    expect((await db!.entityDocument.findUniqueOrThrow({ where: { id: consent.evidenceDocumentId! } })).deletedAt).toBeNull()
  }, 30000)
  it("deletion first: consent waits, then unchanged legal guard sees committed deletion and refuses", async () => {
    const signer = await db!.dealSigner.findFirstOrThrow({ where: { dealId: fx.dealId, document: "SURETYSHIP", clientId: fx.suretyB } })
    const doc = await evidence()
    let deleted!: () => void; const ready = new Promise<void>(r => deleted = r)
    let release!: () => void; const commit = new Promise<void>(r => release = r)
    const deletion = db!.$transaction(async tx => {
      await tx.entityDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date(), deletedById: fx.officer } })
      deleted(); await commit
    }, { timeout: 15000 })
    await ready
    let creating!: (pid: number) => void; const creationPid = new Promise<number>(r => creating = r)
    const creation = db!.$transaction(async tx => {
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      creating(row.pid)
      return tx.suretyConsent.create({ data: consentData(signer.id, doc.id) })
    }).then(() => null, error => String(error))
    try { await waitForLock(await creationPid) } finally { release() }
    await deletion
    expect(await creation).toContain("Spouse consent needs a staff-uploaded wet-ink legal document of this deal")
    expect(await db!.suretyConsent.count({ where: { signerId: signer.id } })).toBe(0)
  }, 30000)
})
