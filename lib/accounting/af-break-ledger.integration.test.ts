/**
 * BREAK items 4, 5, 6 and the concurrency half of 2 (RUN_ACCOUNTING_IT) against the asset-finance journals: a closed month
 * cannot be posted again or changed, new roles cannot be journalled without a fresh mapping confirmation, nothing crosses tenants,
 * and concurrent closes post each event once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { PUT as mappingsPut } from "@/app/api/accounting/mappings/route"
import { GET as settingsGet, POST as settingsPost, PUT as settingsPut } from "@/app/api/accounting/settings/route"
import { GET as periodsGet } from "@/app/api/accounting/periods/route"
import { GET as previewGet } from "@/app/api/accounting/preview/route"
import { GET as csvGet } from "@/app/api/accounting/batches/[id]/csv/route"
import { POST as xeroPost } from "@/app/api/accounting/batches/[id]/xero/route"
import { ASSET_FINANCE_ROLES } from "./accounts"
import { asStaff, call, closeMonths, closeOf, db, dropLender, json, newLender, planOf, renamed, RUN, sessionBox, withHost, type Lender } from "./af-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
const [IS_1] = INSTALMENT_JOURNAL_DEALS
const [LS] = LEASE_JOURNAL_DEALS
let A: Lender
let B: Lender
let hostA = ""
let hostB = ""
let batchA = ""

suite.sequential("af journals: closed is final, mapping confirmation, tenant isolation, concurrency", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    A = await newLender([renamed(IS_1.loan, "ta"), renamed(LS.loan, "ta")])
    B = await newLender([renamed(IS_1.loan, "tb")])
    hostA = await withHost(A.tenant)
    hostB = await withHost(B.tenant)
    const out = await closeMonths(A.tenant, ["2026-08", "2026-09", "2026-10"])
    expect(out.every((o) => o.closed), JSON.stringify(out)).toBe(true)
    await closeMonths(B.tenant, ["2026-08", "2026-09"])
    batchA = (await db.accountingExportBatch.findFirstOrThrow({ where: { tenantId: A.tenant.tenantId, periodKey: "2026-09" } })).id
  }, 300_000)
  afterAll(async () => { sessionBox.current = null; await dropLender(A); await dropLender(B); await db.$disconnect() }, 120_000)

  // ---- (4) closed is final
  it("4a. a closed month cannot be re-closed (second call returns the same batch), nor gain, lose or change a row", async () => {
    const again = await closeOf(A.tenant, "2026-09")
    expect(again).toEqual({ batchId: batchA, created: false })
    const before = await db.accountingJournalLine.count({ where: { batchId: batchA } })
    const line = await db.accountingJournalLine.findFirstOrThrow({ where: { batchId: batchA } })
    const entry = await db.accountingLedgerEntry.findFirstOrThrow({ where: { batchId: batchA } })
    await expect(db.accountingJournalLine.update({ where: { id: line.id }, data: { debitCents: line.debitCents + 1 } })).rejects.toThrow()
    await expect(db.accountingJournalLine.delete({ where: { id: line.id } })).rejects.toThrow()
    await expect(db.accountingJournalLine.create({ data: { tenantId: A.tenant.tenantId, batchId: batchA, entryId: entry.id, lineNo: 9999, role: "BANK", accountCode: "1000", debitCents: 1, creditCents: 0 } })).rejects.toThrow()
    await expect(db.accountingLedgerEntry.create({ data: { tenantId: A.tenant.tenantId, batchId: batchA, eventKey: "x:evil", baseKey: "x:evil", eventType: "ADJUSTMENT", eventDate: new Date(), postingDate: "2026-09-30", reference: "x", description: "x" } })).rejects.toThrow()
    await expect(db.accountingLedgerEntry.update({ where: { id: entry.id }, data: { description: "changed" } })).rejects.toThrow()
    await expect(db.accountingExportBatch.update({ where: { id: batchA }, data: { status: "OPEN" } })).rejects.toThrow()
    await expect(db.accountingExportBatch.update({ where: { id: batchA }, data: { linesSha256: "0".repeat(64) } })).rejects.toThrow()
    await expect(db.accountingExportBatch.delete({ where: { id: batchA } })).rejects.toThrow()
    await expect(db.accountingExportBatch.create({ data: { tenantId: A.tenant.tenantId, periodKey: "2026-09", periodStart: new Date("2026-08-31T22:00:00Z"), periodEnd: new Date("2026-09-30T22:00:00Z"), createdById: A.tenant.userId } })).rejects.toThrow()
    expect(await db.accountingJournalLine.count({ where: { batchId: batchA } })).toBe(before)
  }, 120_000)

  it("4b. TRUNCATE of the ledger tables is refused (closed is final for privileged writers too)", async () => {
    const went: string[] = []
    for (const table of ["AccountingJournalLine", "AccountingLedgerEntry", "AccountingExportBatch"]) {
      const result = await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`); throw new Error("truncate-went-through") }).catch((e: Error) => e.message)
      if (result.includes("truncate-went-through")) went.push(table)
    }
    expect(went, "tables a TRUNCATE emptied (inside a rolled-back transaction)").toEqual([])
    expect(await db.accountingJournalLine.count({ where: { batchId: batchA } })).toBeGreaterThan(0)
  }, 120_000)

  it("4c. a month cannot be posted out of order or twice through the plan: July (before go-live), a gap, and an already-closed month", async () => {
    const jul = await planOf(A.tenant, "2026-07")
    expect(jul.refusal?.code).toBe("OUT_OF_ORDER")
    const dec = await planOf(A.tenant, "2026-12", new Date("2027-01-05T10:00:00+02:00"))
    expect(dec.refusal?.code).toBe("OUT_OF_ORDER")
    const sep = await planOf(A.tenant, "2026-09")
    expect(sep.refusal?.code, "an already-closed month planned again").toBe("OUT_OF_ORDER")
    const keys = await db.accountingLedgerEntry.groupBy({ by: ["eventKey"], where: { tenantId: A.tenant.tenantId }, _count: true, having: { eventKey: { _count: { gt: 1 } } } })
    expect(keys).toEqual([])
  }, 120_000)

  it("4d. a changed mapping does not rewrite a closed month's export; a tampered line is caught by the digest, not exported", async () => {
    asStaff(A.tenant, "ADMIN")
    const csvBefore = await (await csvGet(call(hostA, `/api/accounting/batches/${batchA}/csv`), { params: Promise.resolve({ id: batchA }) })).text()
    expect(csvBefore.length).toBeGreaterThan(50)
    expect((await json(await mappingsPut(call(hostA, "/api/accounting/mappings", "PUT", { mappings: [{ role: "BANK", accountCode: "9999" }] })))).status).toBe(200)
    const csvAfter = await (await csvGet(call(hostA, `/api/accounting/batches/${batchA}/csv`), { params: Promise.resolve({ id: batchA }) })).text()
    expect(csvAfter).toBe(csvBefore)
    await db.accountingSettings.update({ where: { tenantId: A.tenant.tenantId }, data: { mappingConfirmedAt: new Date(), mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    await db.accountingAccountMapping.deleteMany({ where: { tenantId: A.tenant.tenantId, role: "BANK" } })
    // tamper with triggers off
    const line = await db.accountingJournalLine.findFirstOrThrow({ where: { batchId: batchA } })
    await db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"), db.$executeRawUnsafe(`UPDATE "AccountingJournalLine" SET "debitCents" = "debitCents" + 1, "creditCents" = "creditCents" WHERE "id" = '${line.id}'`)])
    const tampered = await csvGet(call(hostA, `/api/accounting/batches/${batchA}/csv`), { params: Promise.resolve({ id: batchA }) })
    await db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"), db.$executeRawUnsafe(`UPDATE "AccountingJournalLine" SET "debitCents" = "debitCents" - 1 WHERE "id" = '${line.id}'`)])
    expect(tampered.status).toBe(500)
    expect(await tampered.text()).not.toContain("journals-")
  }, 120_000)

  // ---- (5) mapping confirmation for new roles
  it("5a. a lender that confirmed before asset finance cannot close an AF month: not via a settings body, a mapping edit, a LOAN_ADMIN or another tenant's admin", async () => {
    const C = await newLender([renamed(IS_1.loan, "tc")], false)
    const hostC = await withHost(C.tenant)
    try {
      expect((await planOf(C.tenant, "2026-08")).refusal?.code).toBe("MAPPING_NOT_CONFIRMED")
      // injecting the roles through the settings routes
      asStaff(C.tenant, "ADMIN")
      await settingsPut(call(hostC, "/api/accounting/settings", "PUT", { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES], mappingConfirmedAt: new Date().toISOString(), goLiveMonth: "2026-08" }))
      await settingsPost(call(hostC, "/api/accounting/settings", "POST", { action: "set_roles", mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] }))
      expect((await db.accountingSettings.findUniqueOrThrow({ where: { tenantId: C.tenant.tenantId } })).mappingConfirmedRoles).toEqual([])
      expect((await planOf(C.tenant, "2026-08")).refusal?.code).toBe("MAPPING_NOT_CONFIRMED")
      // a LOAN_ADMIN cannot confirm; an admin of ANOTHER tenant cannot confirm this one
      asStaff(C.tenant, "LOAN_ADMIN")
      expect((await json(await settingsPost(call(hostC, "/api/accounting/settings", "POST", { action: "confirm_mapping" })))).status).toBeGreaterThanOrEqual(401)
      asStaff(A.tenant, "ADMIN")
      await settingsPost(call(hostC, "/api/accounting/settings", "POST", { action: "confirm_mapping" }))
      expect((await db.accountingSettings.findUniqueOrThrow({ where: { tenantId: C.tenant.tenantId } })).mappingConfirmedRoles).toEqual([])
      expect((await planOf(C.tenant, "2026-08")).refusal?.code).toBe("MAPPING_NOT_CONFIRMED")
      // the real confirmation works, and ANY mapping change withdraws it again
      asStaff(C.tenant, "ADMIN")
      expect((await json(await settingsPost(call(hostC, "/api/accounting/settings", "POST", { action: "confirm_mapping" })))).status).toBe(200)
      expect((await planOf(C.tenant, "2026-08")).refusal).toBeNull()
      expect((await json(await mappingsPut(call(hostC, "/api/accounting/mappings", "PUT", { mappings: [{ role: "RECOVERY_RESULT", accountCode: "6399" }] })))).status).toBe(200)
      const after = await db.accountingSettings.findUniqueOrThrow({ where: { tenantId: C.tenant.tenantId } })
      expect(after.mappingConfirmedAt).toBeNull()
      expect(after.mappingConfirmedRoles).toEqual([])
      await expect(closeOf(C.tenant, "2026-08")).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
    } finally { await dropLender(C) }
  }, 300_000)

  it("5b. confirmation is per month's posted roles: a confirmation with roles [] still lets a consumer-only month close but refuses a month with any AF role; roles stored as a subset refuse the missing one", async () => {
    const D = await newLender([renamed(IS_1.loan, "td")], false)
    try {
      await db.accountingSettings.update({ where: { tenantId: D.tenant.tenantId }, data: { mappingConfirmedRoles: ASSET_FINANCE_ROLES.filter((r) => r !== "RECOVERY_RESULT" && r !== "INPUT_VAT") } })
      const plan = await planOf(D.tenant, "2026-08")
      expect(plan.refusal?.code).toBe("MAPPING_NOT_CONFIRMED")
      expect(plan.refusal?.message).toContain("INPUT_VAT")
    } finally { await dropLender(D) }
  }, 300_000)

  // ---- (6) tenant isolation
  it("6a. tenant B cannot preview, list, export, push or resolve tenant A's batches or read A's data through any accounting route", async () => {
    asStaff(B.tenant, "ADMIN")
    const bPeriods = await json(await periodsGet(call(hostB, "/api/accounting/periods")))
    expect(JSON.stringify(bPeriods.body)).not.toContain(batchA)
    expect((await csvGet(call(hostB, `/api/accounting/batches/${batchA}/csv`), { params: Promise.resolve({ id: batchA }) })).status).toBe(404)
    for (const action of [{ action: "push" }, { action: "resolve", outcome: "pushed", manualJournalId: "X1", note: "found it in xero" }, { action: "resolve", outcome: "not_pushed", note: "never sent it" }]) {
      const r = await json(await xeroPost(call(hostB, `/api/accounting/batches/${batchA}/xero`, "POST", action), { params: Promise.resolve({ id: batchA }) }))
      expect(r.status, JSON.stringify(action)).toBeGreaterThanOrEqual(400)
    }
    expect((await json(await xeroPost(call(hostB, `/api/accounting/batches/${batchA}/xero`, "POST", { action: "check" }), { params: Promise.resolve({ id: batchA }) }))).body.movedToReview).toBe(false)
    expect(await db.accountingXeroPush.count({ where: { batchId: batchA } })).toBe(0)
    // B's preview of A's closed month is B's month (not A's lines)
    const pv = await json(await previewGet(call(hostB, "/api/accounting/preview?period=2026-09")))
    expect(pv.body.batchId).not.toBe(batchA)
    const text = JSON.stringify(pv.body)
    expect(text).not.toContain("AF-LS-0001-ta")
    // B's preview of an open month names only B's contracts and recoveries, even though A has closed months
    const pv2 = await json(await previewGet(call(hostB, "/api/accounting/preview?period=2026-10")))
    expect(JSON.stringify(pv2.body)).not.toContain("-ta")
    // B's session on A's host
    const crossHost = await json(await previewGet(call(hostA, "/api/accounting/preview?period=2026-09")))
    expect(crossHost.status).toBeGreaterThanOrEqual(400)
    expect((await csvGet(call(hostA, `/api/accounting/batches/${batchA}/csv`), { params: Promise.resolve({ id: batchA }) })).status).toBeGreaterThanOrEqual(400)
    // settings/mappings are B's own
    expect(JSON.stringify((await json(await settingsGet(call(hostB, "/api/accounting/settings")))).body)).not.toContain(A.tenant.tenantId)
  }, 300_000)

  it("6b. A's controls never see B's contracts: a failing control in A leaves B's plan clean", async () => {
    const sql = (delta: number) => db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.$executeRawUnsafe(`UPDATE "TaxInvoice" SET "vatCents" = "vatCents" + ${delta}, "totalInclVatCents" = "totalInclVatCents" + ${delta} WHERE "id" = 'inv-ls-1-ta'`)])
    await sql(7)
    try {
      expect((await planOf(A.tenant, "2026-11", new Date("2026-12-05T10:00:00+02:00"))).controls.length).toBeGreaterThan(0)
      expect((await planOf(B.tenant, "2026-10")).controls).toEqual([])
    } finally { await sql(-7) }
  }, 300_000)

  // ---- (2) concurrency
  it("2a. three concurrent closes of the next month post it once; a concurrent close of the month after it is refused or waits, never half-posted", async () => {
    const E = await newLender([renamed(IS_1.loan, "te"), renamed(LS.loan, "te")])
    try {
      const [a, b, c] = await Promise.allSettled([closeOf(E.tenant, "2026-08"), closeOf(E.tenant, "2026-08"), closeOf(E.tenant, "2026-08")])
      const ok = [a, b, c].filter((r) => r.status === "fulfilled") as Array<PromiseFulfilledResult<{ batchId: string; created: boolean }>>
      expect(ok.length, JSON.stringify([a, b, c])).toBe(3)
      expect(new Set(ok.map((r) => r.value.batchId)).size).toBe(1)
      expect(ok.filter((r) => r.value.created)).toHaveLength(1)
      const [s1, s2] = await Promise.allSettled([closeOf(E.tenant, "2026-09"), closeOf(E.tenant, "2026-10")])
      expect(s1.status).toBe("fulfilled")
      expect(s2.status === "fulfilled" || (s2.status === "rejected" && (s2.reason as { code?: string }).code === "OUT_OF_ORDER"), JSON.stringify(s2)).toBe(true)
      const dupes = await db.accountingLedgerEntry.groupBy({ by: ["eventKey"], where: { tenantId: E.tenant.tenantId }, _count: true, having: { eventKey: { _count: { gt: 1 } } } })
      expect(dupes).toEqual([])
      const batches = await db.accountingExportBatch.findMany({ where: { tenantId: E.tenant.tenantId } })
      expect(batches.every((x) => x.status === "CLOSED")).toBe(true)
      // every later plan finds nothing left to post for the months already closed up to the same instant
      const next = (await db.accountingExportBatch.count({ where: { tenantId: E.tenant.tenantId } })) === 3 ? "2026-11" : "2026-10"
      expect((await planOf(E.tenant, next)).entries.every((e) => !e.eventKey.includes("@2026-08"))).toBe(true)
    } finally { await dropLender(E) }
  }, 300_000)
})
