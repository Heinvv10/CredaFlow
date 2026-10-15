/**
 * Slice 4a legal matter service and routes against a real migrated database,
 * driven through the route handlers: open, appoint the attorney (the loan's
 * AttorneyReferral and ATTORNEY_REFERRED stage move, the bureau staff view
 * lists an L, and nothing is confirmed or sent), the NCA summons refused a
 * business day short of the section 129 notice and admitted on day 10 (the
 * guard's own sentence comes back as a 409), a NON_NCA summons refused without
 * a letter of demand, the attachment order and the ASSET_RECOVERED step that
 * opens the s131 Recovery in the same transaction (and rolls back with a
 * refused step), the bell, evidence upload and download (DocumentAccessLog),
 * a settled closure, a cross-tenant id (404) and a READONLY user (403).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/legal-matter.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { saveFile } from "@/lib/storage"
import { listAwaitingAdverse } from "@/lib/bureau-submission/staff-view.server"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { toDayNumber } from "./dates"
import { createRecoveryFixture, day, newLoan, recoveryFixtureTenantId, s129Record, today, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { cleanupLegalFixture, legalRoutes, stepWithEvidence, summonsBoundary } from "./legal-matter.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("@/lib/storage", async (original) => ({ ...await original<typeof import("@/lib/storage")>(), saveFile: vi.fn((await original<typeof import("@/lib/storage")>()).saveFile) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const other = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
let fx: RecoveryFixture
let fxOther: RecoveryFixture
let nca: RecoveryLoan
let non: RecoveryLoan
let readonly = ""
let routes: ReturnType<typeof legalRoutes>
let routesOther: ReturnType<typeof legalRoutes>
const boundary = summonsBoundary()
const state = { ncaMatter: "", nonMatter: "", s129: "", s129Step: "", judgmentStep: "" }

const as = (id: string, role: string, tenantId = fx.tenantId) => {
  session.current = { user: { id, email: `${id}@legal-it.test`, role, tenantId } }
}
const officer = () => as(fx.officer, "CREDIT_OFFICER")
interface Body { id: string; error: string; recoveryId: string; matter: { eligibleSection129Records: { id: string; usedByStepId: string | null }[] } }
const json = async (response: Response) => ({ status: response.status, body: await response.json() as Body })
const step = async (matterId: string, body: Record<string, unknown> | FormData) => json(await routes.step(matterId, body))
const notifications = () => database().notification.findMany({ where: { tenantId: fx.tenantId, type: "LEGAL_MATTER_NEXT_STEP" }, orderBy: { createdAt: "asc" } })

suite("slice 4a legal matter service and routes", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    fxOther = await createRecoveryFixture(database(), other)
    routes = legalRoutes(fx.host)
    routesOther = legalRoutes(fxOther.host)
    nca = await newLoan(database(), fx, "NCA")
    non = await newLoan(database(), fx, "NON_NCA")
    readonly = (await database().user.create({ data: { tenantId: fx.tenantId, email: `readonly-${t}@staff.invalid`, password: "x", role: "READONLY" } })).id
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { bureauReportingStartDate: new Date("2020-01-01T00:00:00Z") } })
    // Completed on the day before the matured date: a step is dated on or after its notice record.
    state.s129 = await s129Record(database(), fx, nca.loanId, "COMPLETED", toDayNumber(today()) - toDayNumber(boundary.matured) + 1)
  }, 120_000)

  afterAll(async () => {
    session.current = null
    await cleanupLegalFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await cleanupLegalFixture(database(), recoveryFixtureTenantId(other)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  it("opens one matter per loan, and a READONLY user cannot write", async () => {
    as(readonly, "READONLY")
    expect((await json(await routes.open(nca.loanId))).status).toBe(403)
    officer()
    const opened = await json(await routes.open(nca.loanId))
    expect(opened.status).toBe(201)
    state.ncaMatter = opened.body.id
    expect(await json(await routes.open(nca.loanId))).toEqual({ status: 409, body: { error: "The loan already has an open legal matter" } })
    as(readonly, "READONLY")
    const view = await json(await routes.loanView(nca.loanId))
    expect(view.status).toBe(200)
    expect(view.body.matter).toMatchObject({ id: state.ncaMatter, status: "OPEN", regime: "NCA", attorney: null, steps: [], nextStep: { code: "SEND_S129" } })
    expect(view.body.matter.eligibleSection129Records).toEqual([expect.objectContaining({ id: state.s129, usedByStepId: null })])
    expect((await json(await routes.appoint(state.ncaMatter, { supplierId: fx.supplier, appointedOn: today() }))).status).toBe(403)
    expect((await step(state.ncaMatter, { kind: "LETTER_OF_DEMAND", stepDate: today() })).status).toBe(403)
  })

  it("refuses an NCA attorney until a section 129 step, the issued notice and the stage are all in place", async () => {
    as(fx.adminA, "LOAN_ADMIN")
    const appoint = async () => json(await routes.appoint(state.ncaMatter, { supplierId: fx.supplier, appointedOn: today() }))
    expect((await json(await routes.appoint(state.ncaMatter, { supplierId: "nope", appointedOn: today() }))).status).toBe(409)
    expect((await json(await routes.appoint(state.ncaMatter, { supplierId: fx.supplier, appointedOn: day(1) }))).status).toBe(400)
    expect(await appoint()).toEqual({ status: 409, body: { error: "An NCA attorney referral needs a completed section 129 notice first" } })
    officer()
    const sent = await step(state.ncaMatter, { kind: "S129_SENT", stepDate: boundary.short, section129RecordId: state.s129 })
    expect(sent.status).toBe(201)
    state.s129Step = sent.body.id
    as(fx.adminA, "LOAN_ADMIN")
    expect((await appoint()).status).toBe(409) // the step alone: the record is not an issued notice and the stage is not SECTION_129_SENT
    await database().complianceRecord.update({ where: { id: state.s129 }, data: { data: { lifecycle: "ISSUED" } } })
    expect((await appoint()).status).toBe(409) // still no stage
    await database().loan.update({ where: { id: nca.loanId }, data: { collectionsStage: "SECTION_129_SENT" } })
    expect(await database().attorneyReferral.count({ where: { loanId: nca.loanId } })).toBe(0)
    expect(await listAwaitingAdverse(fx.tenantId)).toEqual([])
  })

  it("appoints the attorney: referral, stage and the bureau staff view move, and nothing is confirmed or sent", async () => {
    as(fx.adminA, "LOAN_ADMIN")
    const appointed = await json(await routes.appoint(state.ncaMatter, { supplierId: fx.supplier, appointedOn: today() }))
    expect(appointed).toEqual({ status: 200, body: { kind: "done", id: state.ncaMatter, stageSet: true } })
    const loan = await database().loan.findUniqueOrThrow({ where: { id: nca.loanId }, select: { collectionsStage: true, attorneyReferral: true } })
    expect(loan.collectionsStage).toBe("ATTORNEY_REFERRED")
    expect(loan.attorneyReferral).toMatchObject({ firmName: "TEST Plant Sales (Pty) Ltd", createdById: fx.adminA })
    const awaiting = await listAwaitingAdverse(fx.tenantId)
    expect(awaiting).toEqual([expect.objectContaining({ loanId: nca.loanId, statusCode: "L" })])
    expect(await database().bureauAdverseConfirmation.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    expect(await database().bureauSubmissionRecord.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "LEGAL_MATTER_ATTORNEY_APPOINTED", entityId: state.ncaMatter } })).toBe(1)
    const bell = await notifications()
    const appointerBell = bell.filter((n) => n.userId === fx.adminA)
    expect(appointerBell).toHaveLength(1)
    expect(bell.some((n) => n.userId === fx.officer && n.title === appointerBell[0].title)).toBe(true)
    expect(appointerBell[0]).toMatchObject({ title: expect.stringMatching(/^Loan RCVL-\w+: summons may issue from \d{4}-\d{2}-\d{2}$/), entityType: "LegalMatter", entityId: state.ncaMatter })
  })

  it("refuses an NCA summons a business day short of the section 129 notice and admits it on day 10", async () => {
    officer()
    const reused = await step(state.ncaMatter, { kind: "S129_SENT", stepDate: boundary.short, section129RecordId: state.s129 })
    expect(reused).toEqual({ status: 409, body: { error: "That section 129 notice record already backs a step; only a correction may name it again" } })
    expect((await json(await routes.matter(state.ncaMatter))).body.matter.eligibleSection129Records[0].usedByStepId).toBe(state.s129Step)
    const beforeNotice = await s129Record(database(), fx, nca.loanId)
    expect((await step(state.ncaMatter, { kind: "S129_SENT", stepDate: day(-1), section129RecordId: beforeNotice })).body.error).toBe("A section 129 step names this loan's completed section 129 notice record")
    const early = await step(state.ncaMatter, { kind: "SUMMONS_ISSUED", stepDate: boundary.summonsOn })
    expect(early).toEqual({ status: 409, body: { error: "An NCA summons needs a section 129 notice sent at least 10 business days earlier" } })
    const corrected = await step(state.ncaMatter, { kind: "S129_SENT", stepDate: boundary.matured, section129RecordId: state.s129, correctsStepId: state.s129Step })
    expect(corrected.status).toBe(201)
    expect((await step(state.ncaMatter, { kind: "SUMMONS_ISSUED", stepDate: boundary.summonsOn })).status).toBe(201)
    expect(await database().legalMatterStep.count({ where: { matterId: state.ncaMatter, kind: "SUMMONS_ISSUED" } })).toBe(1)
    const hints = (await notifications()).map((n) => n.title)
    expect(hints).toContain(`Loan ${(await database().loan.findUniqueOrThrow({ where: { id: nca.loanId } })).reference}: summons may issue from ${addSouthAfricanBusinessDays(boundary.short, 10)}`)
    expect(hints.some((title) => /serve the summons$/.test(title))).toBe(true)
    expect(hints.join(" ")).not.toMatch(/TEST|Debtor|@/)
  })

  it("refuses bad input and a step on the wrong loan's notice record", async () => {
    expect((await step(state.ncaMatter, { kind: "JUDGMENT", stepDate: day(1) })).status).toBe(400)
    expect((await step(state.ncaMatter, { kind: "S129_SENT", stepDate: today() })).status).toBe(400)
    const foreign = await s129Record(database(), fx, non.loanId)
    const refused = await step(state.ncaMatter, { kind: "S129_SENT", stepDate: today(), section129RecordId: foreign })
    expect(refused).toEqual({ status: 409, body: { error: "A section 129 step names this loan's completed section 129 notice record" } })
  })

  it("stores evidence on a step and logs every read of it", async () => {
    const served = await step(state.ncaMatter, { kind: "SUMMONS_SERVED", stepDate: today() })
    expect(served.status).toBe(201)
    const judgment = await step(state.ncaMatter, stepWithEvidence({ kind: "JUDGMENT", stepDate: today(), note: "default judgment" }))
    expect(judgment.status).toBe(201)
    state.judgmentStep = judgment.body.id
    const row = await database().legalMatterStep.findUniqueOrThrow({ where: { id: judgment.body.id }, include: { evidenceDocument: true } })
    expect(row.evidenceDocument).toMatchObject({ docType: "LEGAL_DOCUMENT", clientId: expect.any(String), entityId: null, uploadedById: fx.officer })
    const download = await routes.document(state.ncaMatter, judgment.body.id, true)
    expect(download.status).toBe(200)
    expect(download.headers.get("content-disposition")).toContain("attachment")
    expect(Buffer.from(await download.arrayBuffer()).toString()).toBe("%PDF-1.4 synthetic court order")
    await routes.document(state.ncaMatter, judgment.body.id)
    const log = await database().documentAccessLog.findMany({ where: { documentId: row.evidenceDocumentId! }, orderBy: { createdAt: "asc" } })
    expect(log.map((l) => [l.action, l.accessorType, l.accessorId])).toEqual([["download", "staff", fx.officer], ["view", "staff", fx.officer]])
    expect((await routes.document(state.ncaMatter, state.s129Step)).status).toBe(404)
  })

  it("rolls a refused step and its evidence back together", async () => {
    const before = await database().entityDocument.count({ where: { tenantId: fx.tenantId, docType: "LEGAL_DOCUMENT" } })
    const refused = await step(state.ncaMatter, stepWithEvidence({ kind: "ASSET_RECOVERED", stepDate: today(), location: "Yard 4", condition: "Fair, no damage" }))
    expect(refused).toEqual({ status: 409, body: { error: "An s131 recovery needs the legal matter's attachment order" } })
    expect(await database().entityDocument.count({ where: { tenantId: fx.tenantId, docType: "LEGAL_DOCUMENT" } })).toBe(before)
    const written = (await vi.mocked(saveFile).mock.results.at(-1)?.value as { storagePath: string })
    expect(existsSync(written.storagePath)).toBe(false)
    expect(await database().legalMatterStep.count({ where: { matterId: state.ncaMatter, kind: "ASSET_RECOVERED" } })).toBe(0)
    expect(await database().recovery.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    expect((await step(state.ncaMatter, { kind: "ASSET_RECOVERED", stepDate: today() })).status).toBe(400)
  })

  it("records the attachment order and the recovery it leads to in one transaction", async () => {
    expect((await step(state.ncaMatter, { kind: "ATTACHMENT_ORDER", stepDate: today() })).status).toBe(201)
    expect((await step(state.ncaMatter, { kind: "ASSET_RECOVERED", stepDate: day(-1), location: "Yard 4", condition: "Fair" })).status).toBe(409)
    expect(await database().recovery.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    const recovered = await step(state.ncaMatter, { kind: "ASSET_RECOVERED", stepDate: today(), location: "Yard 4", condition: "Fair, no damage" })
    expect(recovered.status).toBe(201)
    const recovery = await database().recovery.findUniqueOrThrow({ where: { id: recovered.body.recoveryId } })
    expect(recovery).toMatchObject({ route: "NCA_S131_ATTACHMENT", status: "RECOVERED", legalMatterId: state.ncaMatter, loanId: nca.loanId, location: "Yard 4", createdById: fx.officer })
    const audits = await database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId: { in: [state.ncaMatter, recovery.id] } }, select: { action: true } })
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["LEGAL_MATTER_STEP_RECORDED", "ASSET_RECOVERY_CREATED"]))
    expect((await step(state.ncaMatter, { kind: "ASSET_RECOVERED", stepDate: today(), location: "Yard 4", condition: "Fair" })).status).toBe(409)
    const view = await json(await routes.matter(state.ncaMatter))
    expect(view.body.matter).toMatchObject({ recoveryIds: [recovery.id], nextStep: { code: "CONTINUE_RECOVERY" } })
  })

  it("holds a NON_NCA summons until a letter of demand, then closes on settlement", async () => {
    officer()
    state.nonMatter = (await json(await routes.open(non.loanId))).body.id
    expect((await step(state.nonMatter, { kind: "SUMMONS_ISSUED", stepDate: today() })).body.error).toBe("A NON_NCA summons needs a letter of demand first")
    expect((await step(state.nonMatter, { kind: "S129_SENT", stepDate: today(), section129RecordId: await s129Record(database(), fx, non.loanId) })).body.error).toBe("A section 129 notice belongs to an NCA loan")
    expect((await step(state.nonMatter, { kind: "LETTER_OF_DEMAND", stepDate: today() })).status).toBe(201)
    expect((await step(state.nonMatter, { kind: "SUMMONS_ISSUED", stepDate: today() })).status).toBe(201)
    expect((await step(state.nonMatter, { kind: "JUDGMENT", stepDate: today(), closeMatter: true })).status).toBe(400)
    const settled = await step(state.nonMatter, { kind: "SETTLED", stepDate: today(), closeMatter: true })
    expect(settled.body).toMatchObject({ kind: "done", closed: true })
    expect((await database().legalMatter.findUniqueOrThrow({ where: { id: state.nonMatter } })).status).toBe("CLOSED")
    expect((await step(state.nonMatter, { kind: "WITHDRAWN", stepDate: today() })).body.error).toBe("A step is recorded on an open legal matter")
    expect((await json(await routes.matter(state.nonMatter))).body.matter).toMatchObject({ status: "CLOSED", nextStep: null })
  })

  it("recovers a NON_NCA asset on the court order, with evidence kept against the company", async () => {
    officer()
    const company = await newLoan(database(), fx, "NON_NCA")
    const matter = (await json(await routes.open(company.loanId))).body.id
    expect((await json(await routes.appoint(matter, { supplierId: fx.supplier, appointedOn: today() }))).status).toBe(200) // no section 129 gate off the NCA
    await step(matter, { kind: "LETTER_OF_DEMAND", stepDate: today() })
    expect((await step(matter, { kind: "ASSET_RECOVERED", stepDate: today(), location: "Yard 9", condition: "Fair" })).body.error).toBe("A NON_NCA court-order recovery needs the legal matter's judgment")
    const judgment = await step(matter, stepWithEvidence({ kind: "JUDGMENT", stepDate: today() }))
    const evidence = await database().entityDocument.findFirstOrThrow({ where: { legalMatterSteps: { some: { id: judgment.body.id } } } })
    expect(evidence).toMatchObject({ entityId: company.entityId, clientId: null })
    const recovered = await step(matter, { kind: "ASSET_RECOVERED", stepDate: today(), location: "Yard 9", condition: "Fair" })
    expect((await database().recovery.findUniqueOrThrow({ where: { id: recovered.body.recoveryId } })).route).toBe("NON_NCA_COURT_ORDER")
  })

  it("does not show another lender's matter, loan or document", async () => {
    as(fxOther.officer, "CREDIT_OFFICER", fxOther.tenantId)
    expect((await json(await routesOther.matter(state.ncaMatter))).status).toBe(404)
    expect((await json(await routesOther.loanView(nca.loanId))).status).toBe(404)
    expect((await json(await routesOther.open(nca.loanId))).status).toBe(404)
    expect((await json(await routesOther.appoint(state.ncaMatter, { supplierId: fxOther.supplier, appointedOn: today() }))).status).toBe(404)
    expect((await json(await routesOther.step(state.ncaMatter, { kind: "JUDGMENT", stepDate: today() }))).status).toBe(404)
    expect((await routesOther.document(state.ncaMatter, state.judgmentStep)).status).toBe(404)
    expect(await database().notification.count({ where: { tenantId: fxOther.tenantId } })).toBe(0)
  })
})
