/**
 * Real-Postgres proof of the dealer commission journals (slice 5 part A,
 * docs/asset-finance/SLICE5.md "Commission, runs and journals"): a lender with
 * three dealer deals (dealer-commission.integration-fixture.ts) closes August
 * to December. The ledger holds the hand-worked vectors, the payable control
 * ties to the lines and runs in SQL every month and catches a journal that
 * does not, a month posting the new roles waits for the mapping to be
 * confirmed again, and IsaFlow is sent both codes and refuses without them.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/dealer-commission.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { ACCOUNT_ROLES, ASSET_FINANCE_ROLES, DEFAULT_ACCOUNTS } from "./accounts"
import { insertSourceLoan, removeSourceLoans } from "./asset-finance.integration-fixture"
import { COMMISSION_LOANS, insertDealerCommission, LOAN_X, LOAN_Y, LOAN_Z, removeDealerCommission } from "./dealer-commission.integration-fixture"
import { closePeriod } from "./generate"
import { FakeIsaFlow } from "./isaflow/fake-isaflow.integration-fixture"
import { connectTenant, IT_KEY, IT_TOKEN } from "./isaflow/isaflow.integration-fixture"
import { pushBatchToIsaFlow } from "./isaflow/push"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"
import { assetFinanceControls, journalByKey } from "./reconcile-controls"
import type { Vector } from "./source-types"
import { loadLedger } from "./store"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2027-01-05T10:00:00+02:00")
const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]
const DEALER_ROLES = ["DEALER_COMMISSION_EXPENSE", "DEALER_COMMISSION_PAYABLE"]
const COMMISSION_CODES = ["2600", "6500"]
// The fake IsaFlow's chart: every default code except the two commission accounts, until a test adds them.
const fake = new FakeIsaFlow({
  tokens: { [IT_TOKEN]: ["write:journals", "read:reports"] },
  accounts: [...new Set(ACCOUNT_ROLES.map((r) => DEFAULT_ACCOUNTS[r].code))].filter((c) => !COMMISSION_CODES.includes(c)).map((code) => ({ code })),
})
let tenant: ChargesTenant & { email: string }

const plan = (periodKey: string) => runWithTenant(tenant.tenantId, () => planPeriod(prisma, tenant.tenantId, parsePeriodKey(periodKey)!, AFTER))
const close = (periodKey: string) => runWithTenant(tenant.tenantId, () =>
  closePeriod(prisma, { tenantId: tenant.tenantId, periodKey, userId: tenant.userId, userEmail: tenant.email, now: AFTER }))
const nonEmpty = (v: Vector) => Object.fromEntries(Object.entries(v).filter(([, c]) => c !== 0))
const ck = (loanId: string, lineId: string, paid = false) => `af:${loanId}:dealer-commission${paid ? "-paid" : ""}:${lineId}`

suite.sequential("dealer commission journals (real Postgres)", () => {
  beforeAll(async () => {
    await fake.start()
    vi.stubEnv("WABA_ENC_KEY", IT_KEY)
    vi.stubEnv("ISAFLOW_ALLOWED_ORIGINS", fake.url)
    vi.stubEnv("NODE_ENV", "test")
    const t = await createChargesTenant(db, false)
    tenant = { ...t, email: (await db.user.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true } })).email }
    await removeDealerCommission(db)
    await removeSourceLoans(db, COMMISSION_LOANS.map((l) => l.id))
    for (const loan of COMMISSION_LOANS) await insertSourceLoan(db, tenant, loan)
    await insertDealerCommission(db, tenant)
    // Every role stored at its default code (an IsaFlow push needs the stored mapping); confirmed before the commission roles existed.
    await db.accountingAccountMapping.createMany({ data: ACCOUNT_ROLES.map((role) => ({ tenantId: tenant.tenantId, role, accountCode: DEFAULT_ACCOUNTS[role].code, accountName: DEFAULT_ACCOUNTS[role].name })) })
    await db.accountingSettings.create({ data: {
      tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08", mappingConfirmedRoles: ASSET_FINANCE_ROLES.filter((r) => !DEALER_ROLES.includes(r)),
    } })
    await connectTenant(tenant, fake)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await fake.stop()
    await removeDealerCommission(db)
    await removeSourceLoans(db, COMMISSION_LOANS.map((l) => l.id))
    await db.$disconnect()
  })

  it("refuses a month that posts the commission accounts until the mapping is confirmed again", async () => {
    const refused = await plan("2026-08")
    expect(refused.refusal).toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
    for (const role of DEALER_ROLES) expect(refused.refusal?.message).toContain(role)
    await expect(close("2026-08")).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
    await db.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    expect((await plan("2026-08")).refusal).toBeNull()
  })

  it("ties the payable to the lines and runs in SQL, and catches a journal that does not", async () => {
    const september = await plan("2026-09")
    expect(september.controls).toEqual([])
    const end = parsePeriodKey("2026-09")!.end
    const controls = (keep: (e: (typeof september.entries)[number]) => boolean) => runWithTenant(tenant.tenantId, () =>
      assetFinanceControls(prisma, tenant.tenantId, end, journalByKey(new Map(), new Map(), september.entries.filter(keep))))
    // The run X was paid by is missing from the journal: the books say nothing is owed. Z's cancelled run paid nothing, so Z still ties.
    expect(await controls((e) => !e.baseKey.includes(":dealer-commission-paid:"))).toEqual([
      { control: "DEALER_COMMISSION_PAYABLE", key: LOAN_X.id, journalCents: -201_250, bookCents: 0 },
    ])
    // The commission VAT is missing: the input VAT book has the line's 26 250 on top of the dealer's invoice.
    const vatless = september.entries.map((e) => (e.baseKey.includes(":dealer-commission:") ? { ...e, lines: e.lines.filter((l) => l.role !== "INPUT_VAT") } : e))
    const mismatches = await runWithTenant(tenant.tenantId, () => assetFinanceControls(prisma, tenant.tenantId, end, journalByKey(new Map(), new Map(), vatless)))
    expect(mismatches.filter((c) => c.control === "AF_INPUT_VAT")).toEqual([{ control: "AF_INPUT_VAT", key: LOAN_X.id, journalCents: 150_000, bookCents: 176_250 }])
  })

  it("closes August to December, each balanced with every control at nil", async () => {
    for (const key of MONTHS) {
      const out = await close(key)
      expect(out.created, key).toBe(true)
      const batch = await db.accountingExportBatch.findUniqueOrThrow({ where: { id: out.batchId } })
      expect(batch.totalDebitCents).toBe(batch.totalCreditCents)
      expect((await plan(key)).controls, key).toEqual([])
    }
  })

  it("holds the hand-worked vector of every commission source, each event in its own month", async () => {
    const { posted } = await runWithTenant(tenant.tenantId, () => loadLedger(prisma, tenant.tenantId))
    const held = Object.fromEntries([...posted].filter(([k]) => k.includes(":dealer-commission")).map(([k, v]) => [k, nonEmpty(v)]).filter(([, v]) => Object.keys(v).length > 0))
    expect(held).toEqual({
      [ck(LOAN_X.id, "dcl-it-x1")]: { DEALER_COMMISSION_EXPENSE: 175_000, INPUT_VAT: 26_250, DEALER_COMMISSION_PAYABLE: -201_250 },
      [ck(LOAN_X.id, "dcl-it-x1", true)]: { DEALER_COMMISSION_PAYABLE: 201_250, BANK: -201_250 },
      [ck(LOAN_X.id, "dcl-it-x2")]: { DEALER_COMMISSION_EXPENSE: -175_000, INPUT_VAT: -26_250, DEALER_COMMISSION_PAYABLE: 201_250 },
      [ck(LOAN_X.id, "dcl-it-x2", true)]: { DEALER_COMMISSION_PAYABLE: -201_250, BANK: 201_250 },
      [ck(LOAN_Z.id, "dcl-it-z1")]: { DEALER_COMMISSION_EXPENSE: 80_000, DEALER_COMMISSION_PAYABLE: -80_000 },
      [ck(LOAN_Y.id, "dcl-it-y1")]: { DEALER_COMMISSION_EXPENSE: 300_000, INPUT_VAT: 45_000, DEALER_COMMISSION_PAYABLE: -345_000 },
      [ck(LOAN_Y.id, "dcl-it-y1", true)]: { DEALER_COMMISSION_PAYABLE: 345_000, BANK: -345_000 },
    })
    const entries = await db.accountingLedgerEntry.findMany({
      where: { tenantId: tenant.tenantId, baseKey: { contains: ":dealer-commission" } }, select: { eventKey: true, eventType: true, postingDate: true },
    })
    const byKey = (a: string[], b: string[]) => (a[0] < b[0] ? -1 : 1)
    expect(entries.map((e) => [e.eventKey, e.eventType, e.postingDate]).sort(byKey)).toEqual([
      [ck(LOAN_X.id, "dcl-it-x1"), "DEALER_COMMISSION", "2026-08-10"],
      [ck(LOAN_X.id, "dcl-it-x2"), "DEALER_COMMISSION", "2026-10-20"],
      [ck(LOAN_X.id, "dcl-it-x1", true), "DEALER_COMMISSION_PAID", "2026-09-05"],
      [ck(LOAN_X.id, "dcl-it-x2", true), "DEALER_COMMISSION_PAID", "2026-12-02"],
      [ck(LOAN_Y.id, "dcl-it-y1"), "DEALER_COMMISSION", "2026-11-03"],
      [ck(LOAN_Y.id, "dcl-it-y1", true), "DEALER_COMMISSION_PAID", "2026-12-02"],
      [ck(LOAN_Z.id, "dcl-it-z1"), "DEALER_COMMISSION", "2026-09-12"],
    ].sort(byKey))
  })

  it("pushes a month with commission to IsaFlow only once the chart has both codes, and sends both", async () => {
    const august = await db.accountingExportBatch.findFirstOrThrow({ where: { tenantId: tenant.tenantId, periodKey: "2026-08" }, select: { id: true } })
    const push = () => pushBatchToIsaFlow(prisma, { tenantId: tenant.tenantId, batchId: august.id, actor: { id: tenant.userId, email: tenant.email } })
    expect(await push()).toMatchObject({ ok: false, httpStatus: 422, codes: { missing: COMMISSION_CODES } })
    expect(await db.accountingIsaFlowPush.findUnique({ where: { batchId: august.id } })).toBeNull()
    expect(fake.calls.filter((c) => c.tool === "create_draft_journal")).toEqual([])

    for (const code of COMMISSION_CODES) {
      fake.accounts.push({ id: `00000000-0000-4000-8000-00000000${code}`, account_code: code, account_name: code, account_type: "asset", account_subtype: null, is_active: true, parent_account_id: null })
    }
    expect(await push()).toMatchObject({ ok: true, status: "PUSHED" })
    const draft = fake.listDrafts().find((d) => d.description?.includes(`[credaflow:${august.id}]`))!
    const byCode = (code: string) => draft.lines!.find((l) => l.accountId === `00000000-0000-4000-8000-00000000${code}`)
    expect(byCode("6500")).toMatchObject({ debit: 1750, credit: 0 })
    expect(byCode("2600")).toMatchObject({ debit: 0, credit: 2012.5 })
  })
})
