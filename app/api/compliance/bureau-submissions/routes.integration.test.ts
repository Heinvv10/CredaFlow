/**
 * Real-Postgres proof of the staff bureau-submission routes: the audited,
 * LOAN_ADMIN-gated download; staff generation that is always TEST; and the
 * adverse-listing confirmation that releases a W into the next file.
 *
 * Only the session is stubbed. The role guard, the tenant resolver (by host)
 * and the session-to-tenant binding are the real ones.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/compliance/bureau-submissions/routes.integration.test.ts
 */
import { createHash } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import {
  createBureauLoan,
  createBureauTenant,
  invalidSaId,
  sast,
  syntheticSaId,
  type BureauTenant,
} from "@/lib/bureau-submission/bureau.integration-fixture"
import { generateDaily, generateMonthly } from "@/lib/bureau-submission/generate"
import { parseRecord } from "@/lib/bureau-submission/layout"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { listAwaitingAdverse, listHeldRecords, listSubmissions } from "@/lib/bureau-submission/staff-view.server"
import { POST as generate } from "./route"
import { GET as download } from "./[id]/download/route"
import { POST as confirmAdverse } from "./adverse-confirmations/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

type Role = "LOAN_ADMIN" | "CREDIT_OFFICER" | "READONLY" | "SUPER_ADMIN"
interface Site extends BureauTenant { host: string }

async function site(config?: Parameters<typeof createBureauTenant>[1]): Promise<Site> {
  const tenant = await createBureauTenant(db, config)
  const host = `${tenant.tenantId.replaceAll("_", "-")}.bureau-it.test`
  await db.tenant.update({ where: { id: tenant.tenantId }, data: { domain: host } })
  return { ...tenant, host }
}
const signIn = (t: Site, role: Role) => {
  session.current = { user: { id: t.userId, email: "staff@bureau-it.test", role, tenantId: t.tenantId } }
}
const request = (t: Site, path: string, body?: unknown) => new NextRequest(`http://${t.host}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { host: t.host, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const generateFile = (t: Site, body: unknown) => generate(request(t, "/api/compliance/bureau-submissions", body))
const downloadFile = (t: Site, id: string) =>
  download(request(t, `/api/compliance/bureau-submissions/${id}/download`), { params: Promise.resolve({ id }) })
const confirm = (t: Site, body: unknown) =>
  confirmAdverse(request(t, "/api/compliance/bureau-submissions/adverse-confirmations", body))
const audits = (t: Site, action: string) => db.auditLog.findMany({ where: { tenantId: t.tenantId, action } })

suite.sequential("staff bureau-submission routes (real Postgres)", () => {
  const savedMode = process.env.BUREAU_SUBMISSION_MODE
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: sast("2026-10-01", "09:00:00") })
    // The environment says LIVE; a staff-generated file must still be TEST.
    process.env.BUREAU_SUBMISSION_MODE = "LIVE"
  })
  afterAll(async () => {
    process.env.BUREAU_SUBMISSION_MODE = savedMode
    vi.useRealTimers()
    await db.$disconnect()
  })

  describe("generate", () => {
    it("writes a TEST file even when the environment is LIVE, attributed to the staff member", async () => {
      const t = await site()
      await createBureauLoan(db, t)
      signIn(t, "LOAN_ADMIN")
      const response = await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ outcome: "GENERATED", recordCount: 1, fileName: "TT0109_ALL_T702_M_20260930_1_1" })
      const row = await db.bureauSubmission.findUniqueOrThrow({ where: { id: body.submissionId } })
      expect(row.mode).toBe("TEST")
      const [audit] = await audits(t, "BUREAU_SUBMISSION_GENERATED")
      expect(audit).toMatchObject({ userId: t.userId, entityId: body.submissionId })
      // The file's sha256 is checked for shape only: 64 random hex digits hold
      // 13 decimal digits in a row often enough to fail an ID-number match.
      const { sha256, ...rest } = audit.newValue as Record<string, unknown>
      expect(sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(rest)).not.toMatch(/FIXTURE|\d{13}/)
    })

    it("is refused below LOAN_ADMIN and when signed out, writing nothing", async () => {
      const t = await site()
      await createBureauLoan(db, t)
      signIn(t, "CREDIT_OFFICER")
      expect((await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })).status).toBe(403)
      session.current = null
      expect((await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })).status).toBe(401)
      expect(await db.bureauSubmission.count({ where: { tenantId: t.tenantId } })).toBe(0)
    })

    it("answers 400 to a bad kind, a malformed or unfinished period, and a monthly date that is not a month end", async () => {
      const t = await site()
      signIn(t, "LOAN_ADMIN")
      for (const body of [
        { kind: "WEEKLY", period: "2026-09-30" },
        { kind: "MONTHLY", period: "30/09/2026" },
        { kind: "MONTHLY", period: "2026-09-29" },
        { kind: "DAILY", period: "2026-10-01" },
        { kind: "MONTHLY", period: "2026-10-31" },
      ]) expect((await generateFile(t, body)).status, JSON.stringify(body)).toBe(400)
    })

    it("is 404 while the feature flag is off", async () => {
      const t = await site({ featureBureauSubmission: false })
      signIn(t, "LOAN_ADMIN")
      expect((await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })).status).toBe(404)
    })
  })

  describe("download", () => {
    async function generated(t: Site) {
      signIn(t, "LOAN_ADMIN")
      return (await (await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })).json()) as { submissionId: string; sha256: string; fileName: string }
    }

    it("returns bytes whose sha256 equals the ledger's, and audits the access", async () => {
      const t = await site()
      const loan = await createBureauLoan(db, t)
      const file = await generated(t)
      const response = await downloadFile(t, file.submissionId)
      expect(response.status).toBe(200)
      const bytes = Buffer.from(await response.arrayBuffer())
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const ledger = await db.bureauSubmission.findUniqueOrThrow({ where: { id: file.submissionId } })
      expect(sha256).toBe(ledger.sha256)
      expect(response.headers.get("x-content-sha256")).toBe(ledger.sha256)
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${file.fileName}.txt"`)
      expect(bytes.length).toBe(3 * 702)
      expect(parseRecord(bytes.toString("latin1").split("\r\n")[1], "MONTHLY").accountNumber).toBe(loan.reference)

      const [audit] = await audits(t, "BUREAU_SUBMISSION_DOWNLOADED")
      expect(audit).toMatchObject({ userId: t.userId, entity: "BureauSubmission", entityId: file.submissionId })
      expect(audit.newValue).toMatchObject({ sha256: ledger.sha256, recordCount: 1 })
    })

    it("refuses a non-admin with 403 and a signed-out caller with 401, with no bytes and no audit row", async () => {
      const t = await site()
      await createBureauLoan(db, t)
      const file = await generated(t)
      for (const role of ["CREDIT_OFFICER", "READONLY"] as const) {
        signIn(t, role)
        const response = await downloadFile(t, file.submissionId)
        expect(response.status, role).toBe(403)
        expect(await response.text()).not.toContain("FIXTURE")
      }
      session.current = null
      expect((await downloadFile(t, file.submissionId)).status).toBe(401)
      expect(await audits(t, "BUREAU_SUBMISSION_DOWNLOADED")).toHaveLength(0)
    })

    it("does not serve another tenant's file", async () => {
      const owner = await site()
      await createBureauLoan(db, owner)
      const file = await generated(owner)
      const other = await site()
      signIn(other, "SUPER_ADMIN")
      expect((await downloadFile(other, file.submissionId)).status).toBe(404)
      // Nor does a session for one tenant reach it through the owner's host.
      const crossHost = await downloadFile(owner, file.submissionId)
      expect(crossHost.status).toBe(403)
    })

    it("refuses with 409 when the ledger no longer reproduces the stored hash", async () => {
      const t = await site()
      await createBureauLoan(db, t)
      const file = await generated(t)
      const row = await db.bureauSubmissionRecord.findFirstOrThrow({ where: { submissionId: file.submissionId } })
      await db.bureauSubmissionRecord.update({ where: { id: row.id }, data: { fields: { ...(row.fields as Record<string, string>), surname: "TAMPERED" } } })
      const response = await downloadFile(t, file.submissionId)
      expect(response.status).toBe(409)
      expect(await response.text()).not.toContain("TAMPERED")
      expect(await audits(t, "BUREAU_SUBMISSION_DOWNLOADED")).toHaveLength(0)
    })

    it("answers 410 for a TEST file a newer one replaced, and serves the newer one", async () => {
      const t = await site()
      await createBureauLoan(db, t)
      const first = await generated(t)
      const second = await generated(t)
      const gone = await downloadFile(t, first.submissionId)
      expect(gone.status).toBe(410)
      expect(await gone.text()).not.toContain("FIXTURE")
      expect((await downloadFile(t, second.submissionId)).status).toBe(200)
      const rows = await listSubmissions(t.tenantId)
      expect(rows.map((row) => [row.id, row.superseded])).toEqual([[second.submissionId, false], [first.submissionId, true]])
    })

    it("is 404 once the feature flag is switched off", async () => {
      const t = await site()
      await createBureauLoan(db, t)
      const file = await generated(t)
      await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { featureBureauSubmission: false } })
      expect((await downloadFile(t, file.submissionId)).status).toBe(404)
    })
  })

  describe("the held records list", () => {
    it("shows a record while it is held and drops it once it has been fixed and sent", async () => {
      const t = await site()
      const loan = await createBureauLoan(db, t, { idNumber: invalidSaId() })
      signIn(t, "LOAN_ADMIN")
      await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })
      const held = await listHeldRecords(t.tenantId, new Date())
      expect(held).toHaveLength(1)
      expect(held[0]).toMatchObject({ loanId: loan.loanId, clientId: loan.clientId, reasons: ["INVALID_SA_ID"], kind: "MONTHLY", mode: "TEST", periodDay: "2026-09-30" })

      await db.client.update({ where: { id: loan.clientId }, data: { idNumber: syntheticSaId() } })
      await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })
      expect(await listHeldRecords(t.tenantId, new Date())).toEqual([])
    })

    it("drops a record held in one LIVE month once a later LIVE file sent it", async () => {
      const t = await site()
      const loan = await createBureauLoan(db, t, { idNumber: invalidSaId() })
      const live = (periodDay: string, now: Date) => runWithTenant(t.tenantId, () =>
        generateMonthly(prisma, { tenantId: t.tenantId, periodDay, mode: "LIVE", now, actor: { source: "cron" } }))
      await live("2026-08-31", sast("2026-09-01", "00:20:00"))
      expect((await listHeldRecords(t.tenantId, new Date())).map((row) => [row.loanId, row.mode, row.periodDay]))
        .toEqual([[loan.loanId, "LIVE", "2026-08-31"]])

      await db.client.update({ where: { id: loan.clientId }, data: { idNumber: syntheticSaId() } })
      await live("2026-09-30", sast("2026-10-01", "00:20:00"))
      // The August held row is still in the ledger; it is no longer the latest word on the loan.
      expect(await db.bureauSubmissionRecord.count({ where: { loanId: loan.loanId, heldReason: { not: null } } })).toBe(1)
      expect(await listHeldRecords(t.tenantId, new Date())).toEqual([])
    })

    it("drops a registration the daily file held once the monthly file has sent the account", async () => {
      const t = await site()
      const loan = await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"], idNumber: invalidSaId() })
      const args = { tenantId: t.tenantId, mode: "LIVE" as const, actor: { source: "cron" as const } }
      await runWithTenant(t.tenantId, () => generateDaily(prisma, { ...args, day: "2026-08-20", now: sast("2026-08-21", "00:20:00") }))
      expect((await listHeldRecords(t.tenantId, new Date())).map((row) => [row.kind, row.dataFlag, row.reasons])).toEqual([["DAILY", "R", ["INVALID_SA_ID"]]])
      await db.client.update({ where: { id: loan.clientId }, data: { idNumber: syntheticSaId() } })
      await runWithTenant(t.tenantId, () => generateMonthly(prisma, { ...args, periodDay: "2026-08-31", now: sast("2026-09-01", "00:20:00") }))
      expect(await listHeldRecords(t.tenantId, new Date())).toEqual([])
    })

    it("keeps a held registration on the list when the same daily file sent that loan's closure", async () => {
      const t = await site()
      // Ledger rows written directly: this is about the list, not the generator.
      const loan = await createBureauLoan(db, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
      await db.loan.update({ where: { id: loan.loanId }, data: { status: "COMPLETED", closedAt: sast("2026-08-20", "15:00:00"), totalPaid: 100_000 } })
      const submission = await db.bureauSubmission.create({
        data: { tenantId: t.tenantId, kind: "DAILY", periodDate: new Date("2026-08-20T00:00:00.000Z"), mode: "LIVE", sequence: 1, fileName: "IT", sha256: "x", recordCount: 1, heldCount: 1 },
      })
      const row = { tenantId: t.tenantId, submissionId: submission.id, kind: "DAILY" as const, mode: "LIVE" as const, loanId: loan.loanId, fields: {} }
      await db.bureauSubmissionRecord.createMany({ data: [
        { ...row, dataFlag: "C", statusCode: "T", lineNo: 1 },
        { ...row, dataFlag: "R", heldReason: "REGISTRATION_WITH_LAST_PAYMENT" },
      ] })
      expect((await listHeldRecords(t.tenantId, new Date())).map((held) => [held.dataFlag, held.reasons])).toEqual([["R", ["REGISTRATION_WITH_LAST_PAYMENT"]]])
    })

    it("does not let a later daily line clear a monthly hold", async () => {
      const t = await site()
      const loan = await createBureauLoan(db, t)
      const submission = (kind: "DAILY" | "MONTHLY", day: string, createdAt: Date) => db.bureauSubmission.create({
        data: { tenantId: t.tenantId, kind, periodDate: new Date(`${day}T00:00:00.000Z`), mode: "LIVE", sequence: 1, fileName: "IT", sha256: "x", recordCount: 1, heldCount: 1, createdAt },
      })
      const now = new Date()
      const monthly = await submission("MONTHLY", "2026-08-31", new Date(now.getTime() - 86_400_000))
      const daily = await submission("DAILY", "2026-09-05", now)
      const row = { tenantId: t.tenantId, mode: "LIVE" as const, loanId: loan.loanId, fields: {} }
      await db.bureauSubmissionRecord.createMany({ data: [
        { ...row, submissionId: monthly.id, kind: "MONTHLY", dataFlag: "D", heldReason: "POST_PERIOD_ACTIVITY" },
        { ...row, submissionId: daily.id, kind: "DAILY", dataFlag: "C", statusCode: "T", lineNo: 1 },
      ] })
      expect((await listHeldRecords(t.tenantId, now)).map((held) => [held.kind, held.reasons])).toEqual([["MONTHLY", ["POST_PERIOD_ACTIVITY"]]])
    })

    it("lists only this tenant's records and loans awaiting confirmation", async () => {
      const t = await site()
      const other = await site()
      await createBureauLoan(db, other, { idNumber: invalidSaId() })
      const foreign = await createBureauLoan(db, other)
      await db.loan.update({ where: { id: foreign.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: sast("2026-09-10") } })
      signIn(other, "LOAN_ADMIN")
      await generateFile(other, { kind: "MONTHLY", period: "2026-09-30" })
      expect(await listHeldRecords(other.tenantId, new Date())).toHaveLength(1)
      expect(await listAwaitingAdverse(other.tenantId)).toHaveLength(1)
      expect(await listHeldRecords(t.tenantId, new Date())).toEqual([])
      expect(await listAwaitingAdverse(t.tenantId)).toEqual([])
      expect(await listSubmissions(t.tenantId)).toEqual([])
    })

    it("dates a write-off just after midnight SAST on the SAST day, as the file will", async () => {
      const t = await site()
      const loan = await createBureauLoan(db, t)
      await db.loan.update({ where: { id: loan.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: sast("2026-09-10", "00:30:00") } })
      expect(await listAwaitingAdverse(t.tenantId)).toEqual([{ loanId: loan.loanId, reference: loan.reference, statusCode: "W", eventDay: "2026-09-10" }])
    })
  })

  describe("confirm adverse listing", () => {
    async function writtenOff(t: Site) {
      const loan = await createBureauLoan(db, t)
      await db.loan.update({ where: { id: loan.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: sast("2026-09-10") } })
      return loan
    }
    const statusInFile = async (t: Site, loanId: string) => {
      const body = await (await generateFile(t, { kind: "MONTHLY", period: "2026-09-30" })).json()
      return (await db.bureauSubmissionRecord.findFirstOrThrow({ where: { submissionId: body.submissionId, loanId } })).statusCode
    }

    it("records the notice date with an audit row, and the next file carries W", async () => {
      const t = await site()
      const loan = await writtenOff(t)
      signIn(t, "LOAN_ADMIN")
      expect(await statusInFile(t, loan.loanId)).toBeNull()

      const response = await confirm(t, { loanId: loan.loanId, statusCode: "W", noticeDate: "2026-09-25" })
      expect(response.status).toBe(201)
      const stored = await db.bureauAdverseConfirmation.findFirstOrThrow({ where: { loanId: loan.loanId } })
      expect(stored).toMatchObject({ tenantId: t.tenantId, statusCode: "W", confirmedById: t.userId })
      expect(stored.noticeDate.toISOString().slice(0, 10)).toBe("2026-09-25")
      const [audit] = await audits(t, "BUREAU_ADVERSE_LISTING_CONFIRMED")
      expect(audit).toMatchObject({ userId: t.userId, entity: "Loan", entityId: loan.loanId })
      expect(audit.newValue).toMatchObject({ statusCode: "W", noticeDate: "2026-09-25" })

      expect(await statusInFile(t, loan.loanId)).toBe("W")
      // Confirming twice is refused, not silently repeated.
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "W", noticeDate: "2026-09-25" })).status).toBe(409)
      expect(await audits(t, "BUREAU_ADVERSE_LISTING_CONFIRMED")).toHaveLength(1)
    })

    it("is refused below LOAN_ADMIN and when signed out", async () => {
      const t = await site()
      const loan = await writtenOff(t)
      signIn(t, "CREDIT_OFFICER")
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "W", noticeDate: "2026-09-25" })).status).toBe(403)
      session.current = null
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "W", noticeDate: "2026-09-25" })).status).toBe(401)
      expect(await db.bureauAdverseConfirmation.count({ where: { tenantId: t.tenantId } })).toBe(0)
    })

    it("refuses a loan that is not in that state, a future or malformed date, an unknown status and another tenant's loan", async () => {
      const t = await site()
      const active = await createBureauLoan(db, t)
      const loan = await writtenOff(t)
      const other = await site()
      const foreign = await writtenOff(other)
      signIn(t, "LOAN_ADMIN")
      expect((await confirm(t, { loanId: active.loanId, statusCode: "W", noticeDate: "2026-09-25" })).status).toBe(409)
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "L", noticeDate: "2026-09-25" })).status).toBe(409)
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "W", noticeDate: "2026-10-02" })).status).toBe(400)
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "W", noticeDate: "25 Sep" })).status).toBe(400)
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "Z", noticeDate: "2026-09-25" })).status).toBe(400)
      expect((await confirm(t, { loanId: foreign.loanId, statusCode: "W", noticeDate: "2026-09-25" })).status).toBe(404)
      expect(await db.bureauAdverseConfirmation.count({ where: { tenantId: { in: [t.tenantId, other.tenantId] } } })).toBe(0)
    })

    it("releases L for a loan handed to an attorney", async () => {
      const t = await site()
      const loan = await createBureauLoan(db, t)
      await db.loan.update({ where: { id: loan.loanId }, data: { collectionsStage: "ATTORNEY_REFERRED" } })
      await db.attorneyReferral.create({ data: { loanId: loan.loanId, firmName: "Fixture Attorneys", referralDate: sast("2026-09-12") } })
      signIn(t, "LOAN_ADMIN")
      expect(await statusInFile(t, loan.loanId)).toBeNull()
      expect((await confirm(t, { loanId: loan.loanId, statusCode: "L", noticeDate: "2026-09-01" })).status).toBe(201)
      expect(await statusInFile(t, loan.loanId)).toBe("L")
    })
  })
})
