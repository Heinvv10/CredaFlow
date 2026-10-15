/**
 * Slice 4a legal matter rules (migration 20261015400000), each proved the same
 * way as the lease rules: the attack is refused, and goes through with that one
 * statement or clause taken out of its trigger (or the CHECK / index dropped),
 * inside a rolled-back transaction. One open matter per loan; a closed matter
 * is final; steps are append-only; a section 129 step needs an NCA loan and
 * its completed notice record; an NCA summons waits 10 SA business days after
 * the notice (refused a day short, admitted on the day); a NON_NCA summons
 * needs a prior letter of demand; an attachment order needs a judgment; a
 * correction names a step of the same matter; evidence is a legal document.
 * Legal wording is UNTESTED against the law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-legal.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { dbDate, isoOfDbDate } from "./dates"
import {
  addStep, cleanupRecoveryFixture, createRecoveryFixture, day, legalDocument, newLoan, newMatter, recoveryFixtureTenantId, s129Record, today,
  type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { clauseOff, PASS_DELETE, raiseOff, rules, type Tx } from "./recovery-rules.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const { refuses, admits } = rules(database)
let fx: RecoveryFixture
/** matterA/nonMatter: empty matters; other: a matter with a letter of demand; closed: a closed matter without steps. */
const loans = {} as Record<"nca" | "other" | "closed" | "free" | "non", RecoveryLoan>
const matters = {} as Record<"nca" | "other" | "closed" | "non", string>
const records = {} as { nca: string; non: string; other: string; pending: string; fresh: string; old: string }
let otherStep = ""
/** The last business day (T), the latest S129 date that has matured on T (matured), and the first that has not (short). */
let boundary: { t: string; matured: string; short: string }

const G = "guardLegalMatterStep"
const step = (tx: Tx, matterId: string, kind: string, stepDate = today(), extra: Record<string, unknown> = {}) => tx.legalMatterStep.create({
  data: { tenantId: fx.tenantId, matterId, kind: kind as never, stepDate: dbDate(stepDate), recordedById: fx.officer, ...extra },
})
const s129 = (tx: Tx, matterId: string, recordId: string, stepDate: string, extra: Record<string, unknown> = {}) =>
  step(tx, matterId, "S129_SENT", stepDate, { section129RecordId: recordId, ...extra })

suite("slice 4a legal matter database rules", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    for (const [name, regime] of [["nca", "NCA"], ["other", "NCA"], ["closed", "NCA"], ["free", "NCA"], ["non", "NON_NCA"]] as const) {
      loans[name] = await newLoan(database(), fx, regime)
    }
    for (const name of ["nca", "other", "closed", "non"] as const) matters[name] = await newMatter(database(), fx, loans[name].loanId)
    await database().legalMatter.update({ where: { id: matters.closed }, data: { status: "CLOSED", closedAt: new Date() } })
    // notices sent 60 days ago, so steps dated within the boundary window (the last 40 days) follow them
    records.nca = await s129Record(database(), fx, loans.nca.loanId, "COMPLETED", 60)
    records.non = await s129Record(database(), fx, loans.non.loanId, "COMPLETED", 60)
    records.other = await s129Record(database(), fx, loans.other.loanId, "COMPLETED", 60)
    records.pending = await s129Record(database(), fx, loans.nca.loanId, "PENDING", 60)
    records.fresh = await s129Record(database(), fx, loans.nca.loanId) // sent today
    records.old = await s129Record(database(), fx, loans.nca.loanId, "COMPLETED", 400) // sent before the matter, by more than a year
    otherStep = await addStep(database(), fx, matters.other, "LETTER_OF_DEMAND")
    const [row] = await database().$queryRaw<{ t: Date; matured: Date; short: Date }[]>`
      WITH days AS (SELECT g::date AS d FROM generate_series((now() AT TIME ZONE 'Africa/Johannesburg')::date - 40, (now() AT TIME ZONE 'Africa/Johannesburg')::date, interval '1 day') g),
      last_business AS (SELECT max(d) AS t FROM days WHERE "isSaBusinessDate"(d))
      SELECT lb.t, (SELECT max(d) FROM days WHERE "recoveryAddBusinessDays"(d, 10) = lb.t) AS matured,
        (SELECT min(d) FROM days WHERE "recoveryAddBusinessDays"(d, 10) > lb.t) AS short FROM last_business lb`
    boundary = { t: isoOfDbDate(row.t), matured: isoOfDbDate(row.matured), short: isoOfDbDate(row.short) }
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 60_000)

  it("counts the 10 business days as the application does (SQL and addSouthAfricanBusinessDays agree at the boundary)", () => {
    expect(addSouthAfricanBusinessDays(boundary.matured, 10)).toBe(boundary.t)
    expect(addSouthAfricanBusinessDays(boundary.short, 10) > boundary.t).toBe(true)
  })

  describe("the matter", () => {
    it("allows one OPEN matter per loan, and a new one once it is closed", async () => {
      const second = (tx: Tx) => tx.legalMatter.create({ data: { tenantId: fx.tenantId, loanId: loans.nca.loanId, createdById: fx.officer } })
      await refuses({ index: "LegalMatter_one_open_per_loan" }, /Unique constraint|LegalMatter_one_open_per_loan/, second)
      await admits(async (tx) => {
        await tx.legalMatter.update({ where: { id: matters.nca }, data: { status: "CLOSED", closedAt: new Date() } })
        await second(tx)
      })
    })

    it("is final once CLOSED, and fixes its tenant, loan and creator", async () => {
      await refuses(raiseOff("guardLegalMatter", "A closed legal matter is final"), /closed legal matter is final/,
        (tx) => tx.legalMatter.update({ where: { id: matters.closed }, data: { caseNumber: "CASE-1" } }))
      await refuses(raiseOff("guardLegalMatter", "A legal matter's tenant, loan and creator are fixed"), /tenant, loan and creator are fixed/,
        (tx) => tx.legalMatter.update({ where: { id: matters.nca }, data: { loanId: loans.free.loanId } }))
      await refuses(raiseOff("guardLegalMatter", "A legal matter's tenant, loan and creator are fixed"), /tenant, loan and creator are fixed/,
        (tx) => tx.legalMatter.update({ where: { id: matters.nca }, data: { createdById: fx.adminA } }))
    })

    it("is never deleted and opens OPEN", async () => {
      await refuses(raiseOff("guardLegalMatter", "A legal matter is never deleted", PASS_DELETE), /legal matter is never deleted/, (tx) => tx.legalMatter.delete({ where: { id: matters.nca } }))
      await refuses(raiseOff("guardLegalMatter", "A legal matter opens OPEN"), /opens OPEN/,
        (tx) => tx.legalMatter.create({ data: { tenantId: fx.tenantId, loanId: loans.free.loanId, status: "CLOSED", closedAt: new Date(), createdById: fx.officer } }))
    })

    it("keeps closedAt in step with CLOSED and the attorney with the day of appointment", async () => {
      await refuses({ table: "LegalMatter", constraint: "LegalMatter_closed_columns" }, /LegalMatter_closed_columns/,
        (tx) => tx.legalMatter.update({ where: { id: matters.nca }, data: { status: "CLOSED" } }))
      await refuses({ table: "LegalMatter", constraint: "LegalMatter_attorney_columns" }, /LegalMatter_attorney_columns/,
        (tx) => tx.legalMatter.update({ where: { id: matters.nca }, data: { attorneySupplierId: fx.attorney } }))
      await admits((tx) => tx.legalMatter.update({ where: { id: matters.nca }, data: { attorneySupplierId: fx.attorney, attorneyAppointedOn: dbDate(today()) } }))
    })
  })

  describe("a step", () => {
    it("is append-only: never updated or deleted", async () => {
      await refuses(raiseOff(G, "A legal matter step is append-only: correct it with a new step"), /append-only/,
        (tx) => tx.legalMatterStep.update({ where: { id: otherStep }, data: { note: "edited" } }))
      await refuses(raiseOff(G, "A legal matter step is append-only: correct it with a new step", PASS_DELETE), /append-only/,
        (tx) => tx.legalMatterStep.delete({ where: { id: otherStep } }))
    })

    it("is recorded on an open matter, and not dated in the future", async () => {
      await refuses(raiseOff(G, "A step is recorded on an open legal matter"), /open legal matter/, (tx) => step(tx, matters.closed, "LETTER_OF_DEMAND"))
      await refuses(raiseOff(G, "A step is not dated in the future"), /not dated in the future/, (tx) => step(tx, matters.nca, "LETTER_OF_DEMAND", day(1)))
      await admits((tx) => step(tx, matters.nca, "LETTER_OF_DEMAND", today()))
    })

    it("corrects only a step of the same matter", async () => {
      await refuses(raiseOff(G, "A step corrects a step of the same legal matter"), /same legal matter/,
        (tx) => step(tx, matters.nca, "LETTER_OF_DEMAND", today(), { correctsStepId: otherStep }))
      await admits((tx) => step(tx, matters.other, "LETTER_OF_DEMAND", today(), { correctsStepId: otherStep }))
    })

    it("carries evidence that is a live legal document", async () => {
      const wrongType = await legalDocument(database(), fx, "OTHER")
      const right = await legalDocument(database(), fx)
      await refuses(raiseOff(G, "A step's evidence is a live legal document"), /live legal document/,
        (tx) => step(tx, matters.nca, "LETTER_OF_DEMAND", today(), { evidenceDocumentId: wrongType }))
      await admits((tx) => step(tx, matters.nca, "LETTER_OF_DEMAND", today(), { evidenceDocumentId: right }))
    })

    it("names a section 129 record only on a section 129 step", async () => {
      await refuses({ table: "LegalMatterStep", constraint: "LegalMatterStep_s129_record_only" }, /LegalMatterStep_s129_record_only/,
        (tx) => step(tx, matters.nca, "LETTER_OF_DEMAND", today(), { section129RecordId: records.nca }))
    })
  })

  describe("section 129", () => {
    it("is sent only on an NCA loan", async () => {
      await refuses(raiseOff(G, "A section 129 notice belongs to an NCA loan"), /belongs to an NCA loan/, (tx) => s129(tx, matters.non, records.non, today()))
      await admits((tx) => s129(tx, matters.nca, records.nca, today()))
    })

    it("names this loan's completed section 129 notice record", async () => {
      const message = /completed section 129 notice record/
      const whole = raiseOff(G, "A section 129 step names this loan's completed section 129 notice record")
      await refuses(whole, message, (tx) => step(tx, matters.nca, "S129_SENT"))
      await refuses(whole, message, (tx) => s129(tx, matters.nca, records.other, today()))
      await refuses(whole, message, (tx) => s129(tx, matters.nca, records.pending, today()))
      // each condition on its own: the loan, and the record being completed
      await refuses(clauseOff(G, `AND c."referenceId" = matter."loanId" `), message, (tx) => s129(tx, matters.nca, records.other, today()))
      await refuses(clauseOff(G, `AND c."status" = 'COMPLETED'`), message, (tx) => s129(tx, matters.nca, records.pending, today()))
    })
  })

  describe("section 129 timing", () => {
    it("is dated on or after the day the notice was sent (SAST)", async () => {
      const rule = clauseOff(G, `AND (c."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= NEW."stepDate"`)
      const message = /names this loan's completed section 129 notice record/
      await refuses(rule, message, (tx) => s129(tx, matters.nca, records.fresh, day(-1)))
      await admits((tx) => s129(tx, matters.nca, records.fresh, today()))
    })

    it("names a notice no more than a year older than the matter", async () => {
      await refuses(clauseOff(G, `AND c."completedAt" >= matter."createdAt" - INTERVAL '365 days'`), /names this loan's completed section 129 notice record/,
        (tx) => s129(tx, matters.nca, records.old, today()))
    })

    it("backs one step: a record is not used twice (a correcting step may name it again)", async () => {
      await refuses({ index: "LegalMatterStep_section129_record_once" }, /Unique constraint|LegalMatterStep_section129_record_once/, async (tx) => {
        await s129(tx, matters.nca, records.nca, today())
        await s129(tx, matters.nca, records.nca, today())
      })
      await admits(async (tx) => {
        const first = await s129(tx, matters.nca, records.nca, today())
        await s129(tx, matters.nca, records.nca, today(), { correctsStepId: first.id })
      })
    })
  })

  describe("summons", () => {
    const summons = (tx: Tx, matterId: string, on = boundary.t) => step(tx, matterId, "SUMMONS_ISSUED", on)
    const NCA_WAIT = new RegExp("An NCA summons needs a section 129 notice sent at least 10 business days earlier")

    it("is refused on an NCA loan with no section 129 notice sent", async () => {
      await refuses(clauseOff(G, `IF NOT public."legalMatterS129Matured"(NEW."tenantId", NEW."matterId", NEW."stepDate") THEN`, "IF false THEN"), NCA_WAIT,
        (tx) => summons(tx, matters.nca))
    })

    it("waits 10 SA business days after the notice: refused a day short, admitted on the day", async () => {
      const wait = { fn: "legalMatterS129Matured", replace: [`public."recoveryAddBusinessDays"(s."stepDate", 10) <= on_date`, `s."stepDate" <= on_date`] as const }
      await refuses(wait, NCA_WAIT, async (tx) => {
        await s129(tx, matters.nca, records.nca, boundary.short)
        await summons(tx, matters.nca)
      })
      await admits(async (tx) => {
        await s129(tx, matters.nca, records.nca, boundary.matured)
        await summons(tx, matters.nca)
      })
    })

    it("ignores a section 129 step that a later step corrects", async () => {
      const ignoreCorrected = clauseOff("legalMatterS129Matured", `AND NOT EXISTS (SELECT 1 FROM "LegalMatterStep" c WHERE c."tenantId" = s."tenantId" AND c."correctsStepId" = s."id")`)
      await refuses(ignoreCorrected, NCA_WAIT, async (tx) => {
        const first = await s129(tx, matters.nca, records.nca, boundary.matured)
        await s129(tx, matters.nca, records.nca, today(), { correctsStepId: first.id })
        await summons(tx, matters.nca)
      })
    })

    it("needs a letter of demand first on a NON_NCA loan, dated no later than the summons", async () => {
      const lod = (tx: Tx, on: string) => step(tx, matters.non, "LETTER_OF_DEMAND", on)
      const message = /NON_NCA summons needs a letter of demand first/
      await refuses(raiseOff(G, "A NON_NCA summons needs a letter of demand first"), message, (tx) => summons(tx, matters.non, today()))
      await refuses(clauseOff("legalMatterHasStep", "AND (on_or_before IS NULL OR s.\"stepDate\" <= on_or_before)"), message, async (tx) => {
        await lod(tx, today())
        await summons(tx, matters.non, day(-1))
      })
      await admits(async (tx) => {
        await lod(tx, today())
        await summons(tx, matters.non, today())
      })
    })

    it("ignores a letter of demand that a later step corrects", async () => {
      const ignoreCorrected = clauseOff("legalMatterHasStep", `AND NOT EXISTS (SELECT 1 FROM "LegalMatterStep" c WHERE c."tenantId" = s."tenantId" AND c."correctsStepId" = s."id")`)
      await refuses(ignoreCorrected, /letter of demand first/, async (tx) => {
        const first = await step(tx, matters.non, "LETTER_OF_DEMAND", today())
        await step(tx, matters.non, "SETTLED", today(), { correctsStepId: first.id })
        await summons(tx, matters.non, today())
      })
    })
  })

  describe("attachment order", () => {
    it("needs a judgment on the matter, no later than the order", async () => {
      const message = /attachment order needs a judgment/
      await refuses(raiseOff(G, "An attachment order needs a judgment on the matter first"), message, (tx) => step(tx, matters.nca, "ATTACHMENT_ORDER", today()))
      await refuses(clauseOff("legalMatterHasStep", "AND (on_or_before IS NULL OR s.\"stepDate\" <= on_or_before)"), message, async (tx) => {
        await step(tx, matters.nca, "JUDGMENT", today())
        await step(tx, matters.nca, "ATTACHMENT_ORDER", day(-1))
      })
      await admits(async (tx) => {
        await step(tx, matters.nca, "JUDGMENT", today())
        await step(tx, matters.nca, "ATTACHMENT_ORDER", today())
      })
    })
  })
})
