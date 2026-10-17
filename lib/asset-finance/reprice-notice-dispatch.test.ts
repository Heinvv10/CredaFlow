import { describe, expect, it, vi } from "vitest"
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(), SendBlockedError: class extends Error {} }))
vi.mock("@/lib/contact/identity", () => ({ normaliseEmail: (x: string) => x, lookupContactByChannelValue: vi.fn(async () => ({ id: "contact-1" })) }))
vi.mock("@/lib/audit", () => ({ AuditAction: { ASSET_FINANCE_RATE_NOTICE_DISPATCH: "RATE_NOTICE" }, logAuditStrict: vi.fn() }))
import { MessageReconciliationRequiredError } from "@/lib/messaging/dispatch-control"
import { dispatchRepriceNotices, rateNoticeVars } from "./reprice-notice-dispatch"

const row = {
  id: "notice-1", tenantId: "tenant-1", loanId: "loan-1", contractRateId: "rate-1", loanReference: "AF-TEST",
  effectiveDate: new Date("2026-09-25Z"), firstChangedPaymentDate: new Date("2026-11-01Z"),
  resultingRate: { toString: () => "0.13" }, oldInstalmentCents: 100000, newInstalmentCents: 110000,
  recipientClientIds: ["client-1"], totalInterestCents: 90000, monthlyInterestCents: 1200,
}
const recipient = { id: "client-1", firstName: "SYNTHETIC", lastName: "CLIENT", email: "synthetic@client.invalid" }
function setup() {
  const update = vi.fn(async () => ({}))
  const db = {
    assetFinanceRateNotice: { findMany: vi.fn(async () => [row]), update },
    loan: { findFirst: vi.fn(async () => ({ clientId: "client-1", entityId: null })) },
    client: { findMany: vi.fn(async () => [recipient]) },
    messageTemplate: { findFirst: vi.fn(async () => ({ id: "template-1", tenantId: "tenant-1", statutoryOverride: false, channel: "EMAIL" })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  }
  return { db: db as never, notices: db.assetFinanceRateNotice, update, loan: db.loan, client: db.client, template: db.messageTemplate }
}
describe("written repricing notices", () => {
  it("states the new annual rate, effective date, amount and first changed due date", () => {
    const vars = rateNoticeVars(row as never, recipient)
    expect(vars.text).toContain("13.00%")
    expect(vars.text).toContain("2026-09-25")
    expect(vars.text).toContain("R1100.00")
    expect(vars.text).toContain("2026-11-01")
  })
  it("includes the ascertainable Rand total and monthly interest required by NCA Regulation 36", () => {
    const vars = rateNoticeVars(row as never, recipient, true)
    expect(vars.text).toContain("total interest payable under the agreement is R900.00")
    expect(vars.text).toContain("monthly scheduled period is R12.00")
    expect(vars.text).toContain("assuming the reference rate does not change again")
  })
  it("sends email through the outbound entrypoint with a stable per-recipient idempotency key", async () => {
    const { db, update } = setup()
    const send = vi.fn(async () => ({ id: "message-1", status: "SENT" }))
    expect(await dispatchRepriceNotices(db, "tenant-1", send as never)).toMatchObject({ completed: 1, pending: 0 })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ channel: "EMAIL", contactId: "contact-1", loanId: "loan-1", idempotencyKey: "rate-notice:rate-1:client-1:EMAIL" }))
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completedAt: expect.any(Date) }) }))
  })
  it("sends a new written revision when the actual supply creates its pending tax document", async () => {
    const { db, notices } = setup()
    notices.findMany.mockResolvedValue([{ ...row, taxAdjustmentRevision: 1 }] as never)
    const send = vi.fn(async () => ({ id: "message-tax", status: "SENT" }))
    expect(await dispatchRepriceNotices(db, "tenant-1", send as never)).toEqual({completed:1,pending:0})
    expect(send).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:"rate-notice:rate-1:client-1:EMAIL:tax:1"}))
  })
  it("states that VAT for an unmade supply is provisional and has no issued adjustment document", () => {
    const vars=rateNoticeVars({...row,taxAdjustmentPending:true} as never,recipient)
    expect(vars.text).toContain("provisional booked VAT")
    expect(vars.text).toContain("No VAT adjustment document has been issued for that portion")
  })
  it("uses statutory override only for an NCA borrower", async () => {
    const { db, loan, template } = setup()
    loan.findFirst.mockResolvedValue({ clientId: "client-1", entityId: null, ncaRegime: "NCA" } as never)
    template.findFirst.mockResolvedValue({ id: "template-1", tenantId: "tenant-1", statutoryOverride: true, channel: "EMAIL" })
    await dispatchRepriceNotices(db, "tenant-1", vi.fn(async () => ({ id: "m1", status: "SENT" })) as never)
    expect(template.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ key: "asset_finance_rate_notice_nca_email" }) })
  })
  it("refuses a commercial template that bypasses the recipient's service opt-out", async () => {
    const { db, template } = setup()
    template.findFirst.mockResolvedValue({ id: "template-1", tenantId: "tenant-1", statutoryOverride: true, channel: "EMAIL" })
    const send = vi.fn()
    expect(await dispatchRepriceNotices(db, "tenant-1", send)).toEqual({ completed: 0, pending: 1 })
    expect(send).not.toHaveBeenCalled()
  })
  it("rechecks active acting roles before releasing an entity's notice", async () => {
    const { db, loan, client } = setup()
    loan.findFirst.mockResolvedValue({ clientId: null, entityId: "entity-1" } as never)
    await dispatchRepriceNotices(db, "tenant-1", vi.fn(async () => ({ id: "m1", status: "SENT" })) as never)
    expect(client.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ entityRelationships: { some: { tenantId: "tenant-1", entityId: "entity-1", active: true, role: { in: ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"] } } } }) }))
  })
  it("records an uncertain provider outcome as reconciliation, with its reserved Message id", async () => {
    const { db, update } = setup()
    const send = vi.fn(async () => { throw new MessageReconciliationRequiredError({ id: "uncertain-1" } as never) })
    expect(await dispatchRepriceNotices(db, "tenant-1", send)).toEqual({ completed: 0, pending: 1 })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastOutcomes: [expect.objectContaining({ status: "RECONCILIATION", messageId: "uncertain-1" })] }) }))
  })
  it.each(["SIMULATED", "FAILED", "QUEUED", "SUPPRESSED_BY_CONSENT"])("keeps %s visible and pending, never claims delivery", async (status) => {
    const { db, update } = setup()
    const send = vi.fn(async () => ({ id: "message-1", status }))
    expect(await dispatchRepriceNotices(db, "tenant-1", send as never)).toMatchObject({ completed: 0, pending: 1 })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completedAt: null, lastOutcomes: [expect.objectContaining({ status })] }) }))
  })
})
